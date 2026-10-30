import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Provider } from '@prisma/client';
import { randomBytes } from 'crypto';
import { RateLimitService } from '../auth/rate-limit.service';
import { decrypt } from '../common/crypto';
import { normalizePhone } from '../common/phone';
import { matchInquiries } from '../inquiries/match';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { accessBlocked, billingEnforced } from '../service/plans';
import { InboundService } from './inbound.service';
import { FacebookApi } from './meta-graph.api';
import { metaSignatureOk } from './meta-chat.service';
import { StaffNotifierService } from './staff-notifier.service';
import { WebChatService } from './webchat.service';

const HOUR = 3_600_000;
// The same phone from the same channel inside this time is the same person pressing the button twice
const DUPLICATE_MS = 10 * 60_000;

export interface LeadInput {
  name?: string;
  phone?: string;
  message?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  page?: string;
  externalId?: string;
  channel?: string;
}

const clip = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);

// What the ad marks say about the channel: an Instagram or Facebook campaign is "Instagram", Google is "Google", anything else "Site"
export function channelFromUtm(source?: string, fallback = 'SITE'): string {
  const s = (source ?? '').toLowerCase();
  if (/instagram|^ig$|facebook|^fb$|meta/.test(s)) return 'INSTAGRAM';
  if (/google|gclid|adwords/.test(s)) return 'GOOGLE';
  return fallback;
}

// Requests of people who left their contacts on the clinic's website or in an advertising form. Each becomes an inquiry (the same list
// the funnel uses), is matched to a patient card by phone, and the staff is told. The public address works with a secret key,
// from a browser (only from the sites the clinic listed) and from a form plugin on the server (no Origin).
@Injectable()
export class LeadsService {
  private readonly log = new Logger(LeadsService.name);

  constructor(
    private prisma: PrismaService,
    private limits: RateLimitService,
    private staff: StaffNotifierService,
    private push: PushService,
    private inbound: InboundService,
    private facebook: FacebookApi,
  ) {
    // Ad-form leads come through the durable inbox: a failure to fetch the lead is retried
    this.inbound.register('LEADGEN', async (clinicId, payload) => {
      const { leadgenId, pageId } = payload as { leadgenId: string; pageId: string };
      await this.fromLeadgen(clinicId, pageId, leadgenId);
    });
  }

  // ---------- settings ----------

  async settings(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { leadKey: true, leadEnabled: true, leadOrigins: true } });
    const site = (process.env.WEB_ORIGIN ?? '').replace(/\/$/, '');
    return { enabled: c.leadEnabled, origins: (c.leadOrigins as string[]) ?? [], url: c.leadKey ? `${site}/backend/leads/${c.leadKey}` : null };
  }

  async update(clinicId: string, d: { enabled?: boolean; origins?: string[] }) {
    const cur = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { leadKey: true, isDemo: true } });
    if (cur.isDemo) throw new ForbiddenException('demo_restricted');
    const data: { leadEnabled?: boolean; leadOrigins?: string[]; leadKey?: string } = {};
    if (d.origins !== undefined) {
      const list = [...new Set(d.origins.map((o) => WebChatService.normalizeOrigin(o)))];
      if (list.length > 10 || list.some((o) => !o)) throw new BadRequestException('bad_widget_origin');
      data.leadOrigins = list as string[];
    }
    if (d.enabled !== undefined) {
      data.leadEnabled = d.enabled;
      if (d.enabled && !cur.leadKey) data.leadKey = randomBytes(18).toString('base64url');
    }
    await this.prisma.clinic.update({ where: { id: clinicId }, data });
    return this.settings(clinicId);
  }

  async rotateKey(clinicId: string) {
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { leadKey: randomBytes(18).toString('base64url') } });
    return this.settings(clinicId);
  }

  // ---------- the public address ----------

  private async site(key: string, origin: string | undefined) {
    const c = await this.prisma.clinic.findUnique({ where: { leadKey: key }, select: { id: true, leadEnabled: true, leadOrigins: true, suspendedAt: true, billingStatus: true, paidUntil: true, isDemo: true } });
    if (!c || !c.leadEnabled) throw new NotFoundException();
    // A browser must come from a listed site; a server (no Origin) is let in by the key alone
    if (origin) {
      const o = WebChatService.normalizeOrigin(origin);
      if (!o || !((c.leadOrigins as string[]) ?? []).includes(o)) throw new NotFoundException();
    }
    if (c.suspendedAt || c.isDemo || (billingEnforced() && accessBlocked(c))) throw new ForbiddenException('webchat_unavailable');
    return c;
  }

  async originAllowed(key: string, origin: string | undefined) {
    return this.site(key, origin).then(() => true, () => false);
  }

  async submit(key: string, origin: string | undefined, ip: string, raw: Record<string, unknown>): Promise<{ ok: true }> {
    const c = await this.site(key, origin);
    await this.limits.consume(`leads:ip:${ip}`, 30, HOUR);
    await this.limits.consume(`leads:key:${key}`, 300, HOUR);
    // A hidden field that people leave empty and robots fill in
    if (clip(raw.website, 50) || clip(raw._gotcha, 50)) return { ok: true };
    const lead = this.read(raw);
    await this.save(c.id, lead, 'SITE');
    return { ok: true };
  }

  // The names that form plugins and landing builders commonly use
  private read(raw: Record<string, unknown>): LeadInput {
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = raw[k];
        if (typeof v === 'string' && v.trim()) return v;
      }
      return undefined;
    };
    return {
      name: clip(pick('name', 'full_name', 'fullname', 'your-name', 'Name'), 120),
      phone: clip(pick('phone', 'tel', 'phone_number', 'your-phone', 'Phone'), 40),
      message: clip(pick('message', 'comment', 'note', 'your-message', 'text'), 500),
      utmSource: clip(pick('utm_source', 'utmSource'), 80),
      utmMedium: clip(pick('utm_medium', 'utmMedium'), 80),
      utmCampaign: clip(pick('utm_campaign', 'utmCampaign'), 120),
      page: clip(pick('page', 'url', 'landing', 'referrer'), 300),
      externalId: clip(pick('lead_id', 'externalId'), 80),
    };
  }

  // Creates the inquiry once (a repeated press or a repeated delivery of the same lead does not create a second one) and tells the staff
  async save(clinicId: string, lead: LeadInput, defaultChannel: string): Promise<{ id: string; duplicate: boolean }> {
    const phone = lead.phone && normalizePhone(lead.phone) ? lead.phone : undefined;
    if (!phone && !lead.name && !lead.message) throw new BadRequestException('inquiry_empty');
    const phoneNorm = phone ? normalizePhone(phone) : null;
    const channel = lead.channel ?? channelFromUtm(lead.utmSource, defaultChannel);
    if (lead.externalId) {
      const same = await this.prisma.inquiry.findUnique({ where: { clinicId_externalId: { clinicId, externalId: lead.externalId } }, select: { id: true } });
      if (same) return { id: same.id, duplicate: true };
    }
    if (phoneNorm) {
      const recent = await this.prisma.inquiry.findFirst({ where: { clinicId, phoneNorm, channel, createdAt: { gt: new Date(Date.now() - DUPLICATE_MS) } }, select: { id: true } });
      if (recent) return { id: recent.id, duplicate: true };
    }
    let row;
    try {
      row = await this.prisma.inquiry.create({
        data: { clinicId, channel, phone, phoneNorm, name: lead.name, note: lead.message, utmSource: lead.utmSource, utmMedium: lead.utmMedium, utmCampaign: lead.utmCampaign, landing: lead.page, externalId: lead.externalId },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && lead.externalId) return { id: '', duplicate: true };
      throw e;
    }
    await matchInquiries(this.prisma, clinicId);
    await this.prisma.auditLog.create({ data: { clinicId, action: 'lead.received', details: { id: row.id, channel } } });
    const where = [lead.utmSource, lead.utmCampaign].filter(Boolean).join(' / ');
    await this.staff.notify(clinicId, `Нове звернення (${channel}${where ? `, ${where}` : ''}): ${lead.name ?? 'без імені'}${phone ? `, ${phone}` : ''}${lead.message ? `\n«${lead.message.slice(0, 200)}»` : ''}\n\nВідкрити: ${(process.env.WEB_ORIGIN ?? '').replace(/\/$/, '')}/inquiries`).catch(() => undefined);
    // the phone notification carries no names or numbers
    await this.push.notify(clinicId, { title: 'Нове звернення', body: 'З сайту або реклами', url: '/inquiries', tag: `lead-${row.id}` }).catch(() => undefined);
    return { id: row.id, duplicate: false };
  }

  // ---------- Meta Lead Ads ----------

  // Called with a signed Meta webhook of the Page object: each `leadgen` change is stored in the durable inbox and fetched from there
  async handleWebhook(raw: Buffer | undefined, signature: string | undefined, body: { object?: string; entry?: { id: string; changes?: { field?: string; value?: { leadgen_id?: string; page_id?: string } }[] }[] }) {
    if (!metaSignatureOk(raw, signature) || body.object !== 'page') return;
    for (const entry of body.entry ?? []) {
      for (const ch of entry.changes ?? []) {
        const leadgenId = ch.value?.leadgen_id;
        if (ch.field !== 'leadgen' || !leadgenId) continue;
        const pageId = String(ch.value?.page_id ?? entry.id);
        const i = await this.prisma.integration.findFirst({ where: { OR: [{ provider: Provider.MESSENGER, config: { path: ['ownId'], equals: pageId } }, { provider: Provider.INSTAGRAM, config: { path: ['pageId'], equals: pageId } }] }, select: { clinicId: true } });
        if (!i) continue;
        await this.inbound.receive(i.clinicId, 'LEADGEN', `LEADGEN:${leadgenId}`, { leadgenId, pageId });
      }
    }
  }

  private async fromLeadgen(clinicId: string, pageId: string, leadgenId: string) {
    // The page token is kept by the Messenger connection or, when Messenger was not granted, by the Instagram connection of the same page
    const i = await this.prisma.integration.findFirst({ where: { clinicId, OR: [{ provider: Provider.MESSENGER, config: { path: ['ownId'], equals: pageId } }, { provider: Provider.INSTAGRAM, config: { path: ['pageId'], equals: pageId } }] } });
    if (!i?.apiKeyEnc) return;
    // A failure here is thrown on purpose: the durable inbox tries again
    const data = await this.facebook.getLead(decrypt(i.apiKeyEnc), leadgenId);
    const field = (...names: string[]) => data.field_data?.find((f) => names.includes(f.name))?.values?.[0];
    const first = field('first_name');
    const last = field('last_name');
    await this.save(
      clinicId,
      {
        name: clip(field('full_name') ?? ([first, last].filter(Boolean).join(' ') || undefined), 120),
        phone: clip(field('phone_number', 'phone'), 40),
        message: clip(field('message', 'comments'), 500),
        utmSource: 'meta_lead_ads',
        utmCampaign: clip(data.form_id ? `form ${data.form_id}` : undefined, 120),
        externalId: `leadgen:${leadgenId}`,
        // The platform of an ad form: Instagram or Facebook
        channel: data.platform === 'ig' ? 'INSTAGRAM' : 'OTHER',
      },
      'OTHER',
    );
  }
}
