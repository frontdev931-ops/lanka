import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma, Provider } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { RateLimitService } from '../auth/rate-limit.service';
import { decrypt } from '../common/crypto';
import { normalizePhone } from '../common/phone';
import { matchInquiries } from '../inquiries/match';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { accessBlocked, billingEnforced } from '../service/plans';
import { InboundService } from './inbound.service';
import { FacebookApi, MetaApiError, MetaLead } from './meta-graph.api';
import { hasFeature } from '../service/plans';
import { metaSignatureOk } from './meta-chat.service';
import { FB_MODE } from './meta-login.service';
import { StaffNotifierService } from './staff-notifier.service';
import { WebChatService } from './webchat.service';
import { FORM_ID, leadInstallationCode, readLeadFormConfig } from './lead-form-config';
import { WebsiteRequestsService, websiteRequestState } from './website-requests.service';

const HOUR = 3_600_000;
// The same phone from the same channel inside this time is the same person pressing the button twice
const DUPLICATE_MS = 10 * 60_000;

export interface LeadInput {
  name?: string;
  phone?: string;
  email?: string;
  message?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  page?: string;
  externalId?: string;
  channel?: string;
  // website forms (2026-11-17)
  via?: string;
  formId?: string;
  referrer?: string;
  sourceDetails?: Prisma.InputJsonValue;
}

// The fields a website may send (anything else is ignored, never stored): the documented names first, then the names common form plugins use
const FIELDS = {
  name: ['name', 'full_name', 'fullname', 'your-name', 'Name'],
  phone: ['phone', 'tel', 'phone_number', 'your-phone', 'Phone'],
  email: ['email', 'e-mail', 'your-email', 'Email'],
  message: ['message', 'comment', 'note', 'your-message', 'text'],
  service: ['service', 'requested_service', 'your-service'],
  page: ['page_url', 'page', 'url', 'landing'],
  referrer: ['referrer', 'referer'],
  formId: ['form_id', 'formId'],
  submissionId: ['submission_id', 'submissionId'],
  utmSource: ['utm_source', 'utmSource'],
  utmMedium: ['utm_medium', 'utmMedium'],
  utmCampaign: ['utm_campaign', 'utmCampaign'],
} as const;
const LIMITS: Record<keyof typeof FIELDS, number> = { name: 120, phone: 40, email: 190, message: 1000, service: 120, page: 1000, referrer: 1000, formId: 80, submissionId: 100, utmSource: 80, utmMedium: 80, utmCampaign: 120 };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const SUBMISSION = /^[A-Za-z0-9._:-]{8,100}$/;

// A page address as it may be kept: the site and the path only. The query and the fragment are dropped (they may carry tokens, e-mails, session ids);
// the campaign marks are read from it separately. Not http(s): nothing.
export function cleanPage(raw?: string): { page?: string; utm: { source?: string; medium?: string; campaign?: string } } {
  if (!raw) return { utm: {} };
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { utm: {} };
    const q = (k: string, n: number) => u.searchParams.get(k)?.trim().slice(0, n) || undefined;
    return { page: `${u.origin}${u.pathname}`.slice(0, 300), utm: { source: q('utm_source', 80), medium: q('utm_medium', 80), campaign: q('utm_campaign', 120) } };
  } catch {
    return { utm: {} };
  }
}
// The referring site: its origin only (never its path or query)
export function cleanReferrer(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}
export const secretHash = (secret: string) => createHash('sha256').update(secret).digest('hex');

const clip = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);

// What the ad marks say about the channel: an Instagram or Facebook campaign is "Instagram", Google is "Google", anything else "Site"
export function channelFromUtm(source?: string, fallback = 'SITE'): string {
  const s = (source ?? '').toLowerCase();
  if (/instagram|^ig$|facebook|^fb$|meta/.test(s)) return 'INSTAGRAM';
  if (/google|gclid|adwords/.test(s)) return 'GOOGLE';
  return fallback;
}

// Requests of people who left their contacts on the clinic's website or in an advertising form. Each becomes an inquiry (the same list the funnel uses)
// and the staff is told. Two ways in for a website (2026-11-17): a browser page with the PUBLIC form key (only from the sites the clinic listed), and the
// website's server with the SECRET (Authorization header; Origin is not a credential). The funnel's usual match of an inquiry to a card by phone (to count
// "became a patient") stays as for every inquiry: it is the staff's analytics only. Nothing here links a chat, gives consent, or messages the visitor.
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
    private websiteRequests: WebsiteRequestsService,
  ) {
    // Ad-form leads come through the durable inbox: a failure to fetch the lead is retried
    this.inbound.register('LEADGEN', async (clinicId, payload) => {
      await this.fromLeadgen(clinicId, payload as { leadgenId: string; pageId: string; formId?: string; adId?: string; adgroupId?: string });
    });
  }

  // ---------- settings ----------

  // The owner and the manager see the settings; only the owner sees whether a server secret exists and may create or revoke it (it is never shown again)
  async settings(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { leadKey: true, leadEnabled: true, leadOrigins: true, leadFormConfig: true, leadSecretHint: true, leadSecretHash: true, leadVerifiedAt: true } });
    const site = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
    const origins = (c.leadOrigins as string[]) ?? [];
    const formConfig = readLeadFormConfig(c.leadFormConfig);
    const [last, request] = await Promise.all([
      this.prisma.inquiry.findFirst({ where: { clinicId, via: 'WEBSITE_FORM' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      this.prisma.contactRequest.findFirst({ where: { clinicId }, orderBy: { createdAt: 'desc' }, select: websiteRequestState }),
    ]);
    const receipt = request ? await this.websiteRequests.matchingReceipt(clinicId, request, formConfig) : null;
    return {
      enabled: c.leadEnabled,
      origins,
      formKey: c.leadKey,
      // the browser address (the public form key: it works only from the listed sites) and the server address (needs the secret)
      url: c.leadKey ? `${site}/backend/leads/${c.leadKey}` : null,
      serverUrl: `${site}/backend/leads/v1/enquiries`,
      formConfig,
      formPage: formConfig?.page ?? null,
      snippet: c.leadKey && formConfig && origins.includes(new URL(formConfig.page).origin) ? leadInstallationCode(site, c.leadKey, formConfig) : null,
      secret: { set: !!c.leadSecretHash, hint: c.leadSecretHint },
      // configured is not verified: verified = a real enquiry was accepted from a website form
      verifiedAt: c.leadVerifiedAt,
      lastReceivedAt: last?.createdAt ?? null,
      request,
      requestReceivedAt: receipt?.createdAt ?? null,
    };
  }

  async clinicSettings(clinicId: string) {
    const { formConfig, ...settings } = await this.settings(clinicId);
    return settings;
  }

  async update(clinicId: string, d: { enabled?: boolean; origins?: string[]; formConfig?: Record<string, unknown> | null }) {
    const cur = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { leadOrigins: true, isDemo: true } });
    if (cur.isDemo) throw new ForbiddenException('demo_restricted');
    const data: Prisma.ClinicUpdateInput = {};
    let origins = (cur.leadOrigins as string[]) ?? [];
    if (d.origins !== undefined) {
      const list = [...new Set(d.origins.map((o) => WebChatService.normalizeOrigin(o)))];
      if (list.length > 10 || list.some((o) => !o)) throw new BadRequestException('bad_widget_origin');
      origins = list as string[];
      data.leadOrigins = origins;
    }
    if (d.formConfig === null) {
      data.leadFormConfig = Prisma.DbNull;
    } else if (d.formConfig !== undefined) {
      const config = readLeadFormConfig(d.formConfig);
      if (!config) throw new BadRequestException('bad_lead_form_config');
      if (!origins.includes(new URL(config.page).origin)) throw new BadRequestException('bad_lead_form_origin');
      data.leadFormConfig = { ...config };
    }
    if (d.enabled !== undefined) {
      data.leadEnabled = d.enabled;
    }
    const update = this.prisma.clinic.update({ where: { id: clinicId }, data });
    if (d.enabled || d.formConfig) {
      await this.prisma.$transaction([
        update,
        this.prisma.clinic.updateMany({ where: { id: clinicId, leadKey: null }, data: { leadKey: randomBytes(18).toString('base64url') } }),
      ]);
    } else await update;
  }

  async rotateKey(clinicId: string) {
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { leadKey: randomBytes(18).toString('base64url') } });
    return this.clinicSettings(clinicId);
  }

  // A new server secret (the old one stops working at once). Returned ONCE; only its hash and last four characters are kept.
  async newSecret(clinicId: string) {
    const cur = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { isDemo: true } });
    if (cur.isDemo) throw new ForbiddenException('demo_restricted');
    const secret = `lsk_${randomBytes(30).toString('base64url')}`;
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { leadSecretHash: secretHash(secret), leadSecretHint: secret.slice(-4) } });
    return { secret, settings: await this.clinicSettings(clinicId) };
  }

  async revokeSecret(clinicId: string) {
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { leadSecretHash: null, leadSecretHint: null } });
    return this.clinicSettings(clinicId);
  }

  // ---------- the public addresses ----------

  private async usable(c: { leadEnabled: boolean; suspendedAt: Date | null; isDemo: boolean; billingStatus: string; paidUntil: Date | null } | null) {
    if (!c || !c.leadEnabled) throw new NotFoundException();
    if (c.suspendedAt || c.isDemo || (billingEnforced() && accessBlocked(c))) throw new ForbiddenException('webchat_unavailable');
  }
  private readonly pick = { id: true, leadEnabled: true, leadOrigins: true, suspendedAt: true, billingStatus: true, paidUntil: true, isDemo: true } as const;

  // A browser: the public form key AND a listed site (Origin). No Origin with the public key is a server that must use its secret.
  private async site(key: string, origin: string | undefined) {
    const c = await this.prisma.clinic.findUnique({ where: { leadKey: key }, select: this.pick });
    await this.usable(c);
    if (!origin) throw new UnauthorizedException('lead_server_secret_required');
    const o = WebChatService.normalizeOrigin(origin);
    if (!o || !((c!.leadOrigins as string[]) ?? []).includes(o)) throw new NotFoundException();
    return c!;
  }

  async originAllowed(key: string, origin: string | undefined) {
    return this.site(key, origin).then(() => true, () => false);
  }

  // From a browser page (lanka-forms.js or the site's own script)
  async submit(key: string, origin: string | undefined, ip: string, raw: Record<string, unknown>) {
    const c = await this.site(key, origin);
    await this.limits.consume(`leads:ip:${ip}`, 30, HOUR);
    await this.limits.consume(`leads:key:${key}`, 300, HOUR);
    return this.accept(c.id, raw);
  }

  // From the website's server: Authorization: Bearer <secret>. The clinic is the one whose secret it is; Origin plays no part.
  async submitServer(auth: string | undefined, idempotencyKey: string | undefined, ip: string, raw: Record<string, unknown>) {
    const secret = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!secret.startsWith('lsk_') || secret.length > 100) throw new UnauthorizedException('bad_lead_secret');
    await this.limits.consume(`leads:srv-ip:${ip}`, 600, HOUR);
    const c = await this.prisma.clinic.findUnique({ where: { leadSecretHash: secretHash(secret) }, select: this.pick });
    if (!c) throw new UnauthorizedException('bad_lead_secret');
    await this.usable(c);
    await this.limits.consume(`leads:srv:${c.id}`, 600, HOUR);
    return this.accept(c.id, idempotencyKey ? { ...raw, submission_id: idempotencyKey } : raw);
  }

  private async accept(clinicId: string, raw: Record<string, unknown>): Promise<{ ok: true; id: string | null; duplicate: boolean }> {
    // A hidden field that people leave empty and robots fill in: answered like a success, nothing is stored
    if (clip(raw.website, 50) || clip(raw._gotcha, 50)) return { ok: true, id: null, duplicate: false };
    const f = this.read(raw);
    const r = await this.save(clinicId, f, 'SITE');
    await this.prisma.clinic.updateMany({ where: { id: clinicId, leadVerifiedAt: null }, data: { leadVerifiedAt: new Date() } });
    return { ok: true, id: r.id || null, duplicate: r.duplicate };
  }

  // The documented fields only, each a string of a bounded length; a wrong type or length is refused (not cut silently), unknown fields are ignored
  read(raw: Record<string, unknown>): LeadInput {
    const v: Partial<Record<keyof typeof FIELDS, string>> = {};
    for (const [k, names] of Object.entries(FIELDS) as [keyof typeof FIELDS, readonly string[]][]) {
      const name = names.find((n) => raw[n] !== undefined && raw[n] !== null && raw[n] !== '');
      if (!name) continue;
      const x = raw[name];
      if (typeof x !== 'string' && typeof x !== 'number') throw new BadRequestException('lead_bad_field');
      const t = String(x).trim();
      if (t.length > LIMITS[k]) throw new BadRequestException('lead_bad_field');
      if (t) v[k] = t;
    }
    if (v.email && !EMAIL.test(v.email)) throw new BadRequestException('lead_bad_email');
    if (v.submissionId && !SUBMISSION.test(v.submissionId)) throw new BadRequestException('lead_bad_field');
    if (v.formId && !FORM_ID.test(v.formId)) throw new BadRequestException('lead_bad_field');
    const phone = v.phone && normalizePhone(v.phone) ? v.phone : undefined;
    // a website enquiry needs a way to answer: a phone or an e-mail the visitor typed
    if (!phone && !v.email) throw new BadRequestException('lead_contact_required');
    const page = cleanPage(v.page);
    const message = [v.service ? `Послуга: ${v.service}` : null, v.message].filter(Boolean).join('\n') || undefined;
    return {
      name: v.name,
      phone,
      email: v.email?.toLowerCase(),
      message,
      utmSource: v.utmSource ?? page.utm.source,
      utmMedium: v.utmMedium ?? page.utm.medium,
      utmCampaign: v.utmCampaign ?? page.utm.campaign,
      page: page.page,
      referrer: cleanReferrer(v.referrer),
      formId: v.formId,
      via: 'WEBSITE_FORM',
      // a retry of the same submission carries the same id: one enquiry
      externalId: v.submissionId ? `web:${v.submissionId}` : undefined,
    };
  }

  // Creates the inquiry once (a repeated press or a repeated delivery of the same lead does not create a second one) and tells the staff
  async save(clinicId: string, lead: LeadInput, defaultChannel: string): Promise<{ id: string; duplicate: boolean }> {
    const phone = lead.phone && normalizePhone(lead.phone) ? lead.phone : undefined;
    if (!phone && !lead.email && !lead.name && !lead.message) throw new BadRequestException('inquiry_empty');
    const phoneNorm = phone ? normalizePhone(phone) : null;
    const channel = lead.channel ?? channelFromUtm(lead.utmSource, defaultChannel);
    if (lead.externalId) {
      const same = await this.prisma.inquiry.findUnique({ where: { clinicId_externalId: { clinicId, externalId: lead.externalId } }, select: { id: true } });
      if (same) return { id: same.id, duplicate: true };
    }
    // Without a submission id: the very same enquiry again (the same contact, words and form, minutes apart) is the same press twice. A different
    // message or form from the same person is a separate enquiry and is kept.
    if (!lead.externalId && (phoneNorm || lead.email)) {
      const recent = await this.prisma.inquiry.findFirst({
        where: { clinicId, channel, ...(phoneNorm ? { phoneNorm } : { email: lead.email }), note: lead.message ?? null, formId: lead.formId ?? null, createdAt: { gt: new Date(Date.now() - DUPLICATE_MS) } },
        select: { id: true },
      });
      if (recent) return { id: recent.id, duplicate: true };
    }
    let row;
    try {
      row = await this.prisma.inquiry.create({
        data: { clinicId, channel, phone, phoneNorm, name: lead.name, email: lead.email, note: lead.message, utmSource: lead.utmSource, utmMedium: lead.utmMedium, utmCampaign: lead.utmCampaign, landing: lead.page, externalId: lead.externalId, via: lead.via, formId: lead.formId, referrer: lead.referrer, ...(lead.sourceDetails ? { sourceDetails: lead.sourceDetails } : {}) },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && lead.externalId) {
        // two deliveries of one submission at the same moment: the other one created it
        const same = await this.prisma.inquiry.findUnique({ where: { clinicId_externalId: { clinicId, externalId: lead.externalId } }, select: { id: true } });
        return { id: same?.id ?? '', duplicate: true };
      }
      throw e;
    }
    await matchInquiries(this.prisma, clinicId);
    // the log keeps the id and the route only (no name, contact or text)
    await this.prisma.auditLog.create({ data: { clinicId, action: 'lead.received', details: { id: row.id, channel, ...(lead.via ? { via: lead.via } : {}) } } });
    const where = [lead.utmSource, lead.utmCampaign].filter(Boolean).join(' / ');
    await this.staff.notify(clinicId, `Нове звернення (${channel}${where ? `, ${where}` : ''}): ${lead.name ?? 'без імені'}${phone ? `, ${phone}` : lead.email ? `, ${lead.email}` : ''}${lead.message ? `\n«${lead.message.slice(0, 200)}»` : ''}\n\nВідкрити: ${(process.env.WEB_ORIGIN ?? '').replace(/\/$/, '')}/inquiries`).catch(() => undefined);
    // the phone notification carries no names or numbers
    await this.push.notify(clinicId, { title: 'Нове звернення', body: 'З сайту або реклами', url: '/inquiries', tag: `lead-${row.id}` }).catch(() => undefined);
    return { id: row.id, duplicate: false };
  }

  // ---------- Meta Lead Ads ----------
  // The clinic is the one whose CONNECTED page the notification names (the signed webhook of the Page object); a clinic id in a payload is never read.
  // Each lead id goes once into the durable inbox (a repeated notification is the same event), is fetched from Meta with the page token, and becomes
  // one inquiry (externalId leadgen:<id>, unique per clinic). A lead is not a patient identity, not consent, and nothing is sent to the person.

  // Called with a signed Meta webhook of the Page object: each `leadgen` change is stored in the durable inbox and fetched from there
  async handleWebhook(raw: Buffer | undefined, signature: string | undefined, body: { object?: string; entry?: { id: string; changes?: { field?: string; value?: { leadgen_id?: string; page_id?: string; form_id?: string; ad_id?: string; adgroup_id?: string; created_time?: number } }[] }[] }) {
    if (!metaSignatureOk(raw, signature) || body.object !== 'page') return;
    for (const entry of body.entry ?? []) {
      for (const ch of entry.changes ?? []) {
        const v = ch.value ?? {};
        const leadgenId = typeof v.leadgen_id === 'string' || typeof v.leadgen_id === 'number' ? String(v.leadgen_id) : '';
        if (ch.field !== 'leadgen' || !/^\d{1,30}$|^[A-Za-z0-9_-]{1,64}$/.test(leadgenId)) continue;
        const pageId = String(v.page_id ?? entry.id);
        const i = await this.pageConnection(pageId);
        if (!i) continue;
        // only what identifies the lead travels in the inbox; the person's answers are fetched from Meta when it is handled
        const ids = (x: unknown) => (typeof x === 'string' || typeof x === 'number' ? String(x).slice(0, 40) : undefined);
        await this.inbound.receive(i.clinicId, 'LEADGEN', `LEADGEN:${leadgenId}`, { leadgenId, pageId, formId: ids(v.form_id), adId: ids(v.ad_id), adgroupId: ids(v.adgroup_id) });
      }
    }
  }

  // The page's connection: Messenger keeps the page token; without Messenger, the Instagram connection of the same page does
  private pageConnection(pageId: string, clinicId?: string) {
    return this.prisma.integration.findFirst({ where: { ...(clinicId ? { clinicId } : {}), apiKeyEnc: { not: null }, OR: [{ provider: Provider.MESSENGER, config: { path: ['ownId'], equals: pageId } }, { provider: Provider.INSTAGRAM, config: { path: ['pageId'], equals: pageId } }] }, orderBy: { provider: 'asc' } });
  }

  // What went wrong with a lead, in words the settings can explain: the token ended, the permission is missing, the lead or form is not available
  static leadProblem(e: unknown): 'token' | 'permission' | 'unavailable' | null {
    if (!(e instanceof MetaApiError)) return null;
    if (e.code === 190) return 'token';
    if (e.code === 10 || (e.code !== undefined && e.code >= 200 && e.code < 300)) return 'permission';
    if (e.code === 100) return 'unavailable';
    return null;
  }

  private async markLeadAds(clinicId: string, pageId: string, data: { problem: string | null; lastAt?: string }) {
    const rows = await this.prisma.integration.findMany({ where: { clinicId, OR: [{ provider: Provider.MESSENGER, config: { path: ['ownId'], equals: pageId } }, { provider: Provider.INSTAGRAM, config: { path: ['pageId'], equals: pageId } }] } });
    for (const r of rows) {
      const cfg = (r.config ?? {}) as Record<string, unknown>;
      const prev = (cfg.leadAds ?? {}) as Record<string, unknown>;
      await this.prisma.integration.update({ where: { id: r.id }, data: { config: { ...cfg, leadAds: { ...prev, problem: data.problem, problemAt: data.problem ? new Date().toISOString() : null, ...(data.lastAt ? { lastAt: data.lastAt } : {}) } } as Prisma.InputJsonValue } });
    }
  }

  private async fromLeadgen(clinicId: string, payload: { leadgenId: string; pageId: string; formId?: string; adId?: string; adgroupId?: string }) {
    const { leadgenId, pageId } = payload;
    const i = await this.pageConnection(pageId, clinicId);
    // the page is no longer connected to this clinic: nothing to fetch with (a staff retry after reconnecting picks it up)
    if (!i?.apiKeyEnc) throw new Error('page_not_connected');
    let data: MetaLead;
    try {
      data = await this.facebook.getLead(decrypt(i.apiKeyEnc), leadgenId);
    } catch (e) {
      // thrown on purpose: the durable inbox tries again with pauses, then keeps it as FAILED for a staff retry; the settings say why
      const problem = LeadsService.leadProblem(e);
      if (problem) await this.markLeadAds(clinicId, pageId, { problem });
      throw e;
    }
    const lead = mapMetaLead(data);
    const details: Record<string, unknown> = {
      source: 'META_LEAD_ADS',
      pageId,
      leadId: leadgenId,
      formId: data.form_id ?? payload.formId ?? null,
      adId: data.ad_id ?? payload.adId ?? null,
      adsetId: data.adset_id ?? payload.adgroupId ?? null,
      campaignId: data.campaign_id ?? null,
      platform: data.platform ?? null,
      organic: typeof data.is_organic === 'boolean' ? data.is_organic : null,
      createdTime: data.created_time ?? null,
      answers: lead.answers,
    };
    await this.save(
      clinicId,
      {
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        message: lead.message,
        externalId: `leadgen:${leadgenId}`,
        via: 'META_LEAD_ADS',
        formId: (data.form_id ?? payload.formId)?.slice(0, 80),
        // the platform of the ad form: Instagram, or Facebook (kept as "other" among the inquiry channels); no campaign marks are made up
        channel: data.platform === 'ig' ? 'INSTAGRAM' : 'OTHER',
        sourceDetails: details as Prisma.InputJsonValue,
      },
      'OTHER',
    );
    await this.markLeadAds(clinicId, pageId, { problem: null, lastAt: new Date().toISOString() });
  }

  // Settings → Channels → Instagram and Facebook: what the clinic's ad forms need and what is happening (owner and manager)
  async leadAdsStatus(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true } });
    const rows = await this.prisma.integration.findMany({ where: { clinicId, provider: { in: [Provider.MESSENGER, Provider.INSTAGRAM] }, apiKeyEnc: { not: null } }, orderBy: { provider: 'asc' } });
    const cfgOf = (r: (typeof rows)[number]) => (r.config ?? {}) as { name?: string; mode?: string; pageId?: string; ownId?: string; leads?: boolean; leadsSubscribed?: boolean; tokenProblem?: string | null; leadAds?: { problem?: string | null; problemAt?: string | null; lastAt?: string } };
    const row = rows.find((r) => r.provider === Provider.MESSENGER) ?? rows[0];
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [received, last, failed, retrying] = await Promise.all([
      this.prisma.inquiry.count({ where: { clinicId, via: 'META_LEAD_ADS', createdAt: { gt: since } } }),
      this.prisma.inquiry.findFirst({ where: { clinicId, via: 'META_LEAD_ADS' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      this.prisma.inboundEvent.findMany({ where: { clinicId, channel: 'LEADGEN', status: 'FAILED' }, select: { id: true }, take: 50 }),
      this.prisma.inboundEvent.count({ where: { clinicId, channel: 'LEADGEN', status: 'PENDING', attempts: { gt: 0 } } }),
    ]);
    const cfg = row ? cfgOf(row) : null;
    const viaLogin = cfg?.mode === FB_MODE;
    // permission: true/false when the clinic connected with Facebook login (the granted scopes are known); null when a page token was pasted by hand
    const permission = cfg ? (viaLogin ? !!cfg.leads : null) : null;
    const problem = cfg?.tokenProblem === 'invalid' ? 'token' : (cfg?.leadAds?.problem ?? null);
    const state = !c || !hasFeature(c.plan, 'multi_channel') ? 'plan' : !cfg ? 'not_connected' : problem === 'token' ? 'token' : permission === false || problem === 'permission' ? 'permission' : problem === 'unavailable' ? 'unavailable' : permission === null ? 'unknown' : !cfg.leadsSubscribed ? 'not_subscribed' : last ? 'receiving' : 'waiting';
    return {
      state,
      page: cfg ? { id: cfg.pageId ?? cfg.ownId ?? null, name: cfg.name ?? null } : null,
      permission,
      subscribed: cfg ? !!cfg.leadsSubscribed : false,
      lastLeadAt: last?.createdAt ?? null,
      received30d: received,
      failed: failed.map((f) => f.id),
      retrying,
      // configured is not verified: verified = a real lead was received and stored
      verified: !!last,
    };
  }
}

// The fields of a Meta lead form: the common ones by their standard names; the clinic's own questions kept as question + answer text (at most 10,
// each bounded); personal details the clinic did not need here (address, birth date, job...) are not kept at all.
const STANDARD_SKIP = new Set(['street_address', 'city', 'state', 'province', 'country', 'zip_code', 'post_code', 'zip', 'date_of_birth', 'dob', 'gender', 'marital_status', 'relationship_status', 'military_status', 'job_title', 'work_email', 'work_phone_number', 'company_name', 'national_id', 'cpf', 'dni', 'rut', 'cuit', 'nit', 'ruc', 'cpi', 'id_ar', 'id_cl', 'id_co', 'id_ec', 'id_pe']);
const NAME = ['full_name', 'name'];
const PHONE = ['phone_number', 'phone'];
const LEAD_EMAIL = ['email'];
const MESSAGE = ['message', 'comments', 'comment', 'question'];
const plain = (v: string, n: number) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, n);
export function mapMetaLead(data: MetaLead): { name?: string; phone?: string; email?: string; message?: string; answers: { q: string; a: string }[] } {
  const fields = (data.field_data ?? []).filter((f) => f && typeof f.name === 'string');
  const val = (f: { values?: string[] }) => (Array.isArray(f.values) ? f.values.filter((x) => typeof x === 'string').join(', ') : '');
  const get = (names: string[]) => {
    const f = fields.find((x) => names.includes(x.name.toLowerCase()));
    return f ? plain(val(f), 500) || undefined : undefined;
  };
  const first = get(['first_name']);
  const last = get(['last_name']);
  const email = get(LEAD_EMAIL)?.toLowerCase();
  const used = new Set([...NAME, 'first_name', 'last_name', ...PHONE, ...LEAD_EMAIL, ...MESSAGE]);
  const answers = fields
    .filter((f) => !used.has(f.name.toLowerCase()) && !STANDARD_SKIP.has(f.name.toLowerCase()))
    .map((f) => ({ q: plain(f.name.replace(/_/g, ' '), 120), a: plain(val(f), 300) }))
    .filter((x) => x.q && x.a)
    .slice(0, 10);
  return {
    name: plain(get(NAME) ?? ([first, last].filter(Boolean).join(' ') || ''), 120) || undefined,
    phone: get(PHONE)?.slice(0, 40),
    email: email && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) ? email : undefined,
    message: get(MESSAGE)?.slice(0, 1000),
    answers,
  };
}
