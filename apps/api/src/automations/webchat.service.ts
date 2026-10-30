import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { RateLimitService } from '../auth/rate-limit.service';
import { normalizePhone } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import { accessBlocked, billingEnforced, hasFeature } from '../service/plans';
import { IntakeService } from './intake.service';

const HOUR = 3_600_000;
const MAX_ORIGINS = 10;
const MAX_TEXT = 1000;

export interface WebChatMessage {
  id: string;
  direction: 'IN' | 'OUT';
  text: string;
  createdAt: Date;
  buttons: { label: string; payload: string }[];
}

// The chat widget of the clinic's own website. The visitor is anonymous: nothing they type is trusted as identity, so a chat is never
// linked to a patient card automatically (staff link it). The widget key only says which clinic the site belongs to, and the site's
// address (Origin) must be on the clinic's list; limits keep a bot or a prank from using the clinic's AI allowance.
@Injectable()
export class WebChatService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private limits: RateLimitService,
    private intake: IntakeService,
  ) {}

  private secret() {
    return `${process.env.JWT_SECRET ?? ''}:webchat`;
  }

  static normalizeOrigin(raw: string): string | null {
    try {
      const u = new URL(raw.trim());
      const local = u.hostname === 'localhost' && process.env.NODE_ENV !== 'production';
      if (u.protocol !== 'https:' && !local) return null;
      return u.origin.toLowerCase();
    } catch {
      return null;
    }
  }

  // ---- settings (the owner or manager, signed in) ----

  async settings(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { widgetKey: true, widgetEnabled: true, widgetOrigins: true, widgetGreeting: true } });
    const site = (process.env.WEB_ORIGIN ?? '').replace(/\/$/, '');
    return {
      enabled: c.widgetEnabled,
      origins: (c.widgetOrigins as string[]) ?? [],
      greeting: c.widgetGreeting,
      snippet: c.widgetKey ? `<script src="${site}/widget.js" data-key="${c.widgetKey}" async></script>` : null,
    };
  }

  async update(clinicId: string, d: { enabled?: boolean; origins?: string[]; greeting?: string | null }) {
    const cur = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true, widgetKey: true, isDemo: true } });
    if (cur.isDemo) throw new ForbiddenException('demo_restricted');
    const data: { widgetEnabled?: boolean; widgetOrigins?: string[]; widgetGreeting?: string | null; widgetKey?: string } = {};
    if (d.origins !== undefined) {
      const list = [...new Set(d.origins.map((o) => WebChatService.normalizeOrigin(o)))];
      if (list.length > MAX_ORIGINS || list.some((o) => !o)) throw new BadRequestException('bad_widget_origin');
      data.widgetOrigins = list as string[];
    }
    if (d.greeting !== undefined) data.widgetGreeting = d.greeting?.trim().slice(0, 300) || null;
    if (d.enabled !== undefined) {
      if (d.enabled && !hasFeature(cur.plan, 'multi_channel')) throw new BadRequestException('plan_feature');
      data.widgetEnabled = d.enabled;
      if (d.enabled && !cur.widgetKey) data.widgetKey = randomBytes(18).toString('base64url');
    }
    await this.prisma.clinic.update({ where: { id: clinicId }, data });
    return this.settings(clinicId);
  }

  // A new key invalidates the old snippet (for example if the key leaked); open sessions stop working
  async rotateKey(clinicId: string) {
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { widgetKey: randomBytes(18).toString('base64url') } });
    return this.settings(clinicId);
  }

  // ---- public side (the visitor's browser) ----

  private async site(key: string, origin: string | undefined) {
    const c = await this.prisma.clinic.findUnique({ where: { widgetKey: key }, select: { id: true, name: true, widgetEnabled: true, widgetOrigins: true, widgetGreeting: true, suspendedAt: true, billingStatus: true, paidUntil: true, isDemo: true } });
    // A wrong key and a wrong site look the same
    const o = origin ? WebChatService.normalizeOrigin(origin) : null;
    if (!c || !c.widgetEnabled || !o || !((c.widgetOrigins as string[]) ?? []).includes(o)) throw new NotFoundException();
    if (c.suspendedAt || (billingEnforced() && accessBlocked(c))) throw new ForbiddenException('webchat_unavailable');
    return c;
  }

  // Used by the controller to answer the CORS check: the site may talk to the API only if it is on the clinic's list
  async originAllowed(key: string, origin: string | undefined): Promise<boolean> {
    return this.site(key, origin).then(() => true, () => false);
  }

  async config(key: string, origin: string | undefined) {
    const c = await this.site(key, origin);
    return { name: c.name, greeting: c.widgetGreeting };
  }

  async startSession(key: string, origin: string | undefined, ip: string, d: { name?: string; phone?: string }) {
    const c = await this.site(key, origin);
    await this.limits.consume(`webchat:ip:session:${ip}`, 20, HOUR);
    const chatId = `w-${randomBytes(9).toString('base64url')}`;
    const name = (d.name ?? '').trim().slice(0, 80);
    const phone = d.phone && normalizePhone(d.phone) ? d.phone.trim().slice(0, 30) : '';
    const token = await this.jwt.signAsync({ typ: 'webchat', k: key, c: chatId, n: [name, phone].filter(Boolean).join(' · ') || null }, { secret: this.secret(), expiresIn: '24h' });
    return { token, clinicId: c.id };
  }

  private async session(key: string, origin: string | undefined, auth: string | undefined) {
    const c = await this.site(key, origin);
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    let p: { typ?: string; k?: string; c?: string; n?: string | null };
    try {
      p = await this.jwt.verifyAsync(token, { secret: this.secret() });
    } catch {
      throw new UnauthorizedException();
    }
    if (p.typ !== 'webchat' || p.k !== key || !p.c) throw new UnauthorizedException();
    return { clinicId: c.id, chatId: p.c, name: p.n ?? null };
  }

  private view(rows: { id: string; direction: string; text: string; createdAt: Date; buttons: unknown }[]): WebChatMessage[] {
    return rows.map((m) => ({ id: m.id, direction: m.direction as 'IN' | 'OUT', text: m.text, createdAt: m.createdAt, buttons: Array.isArray(m.buttons) ? (m.buttons as { label: string; payload: string }[]) : [] }));
  }

  async send(key: string, origin: string | undefined, auth: string | undefined, ip: string, d: { text?: string; payload?: string }) {
    const s = await this.session(key, origin, auth);
    await this.limits.consume(`webchat:msg:${s.chatId}`, 20, 10 * 60_000);
    await this.limits.consume(`webchat:ip:${ip}`, 80, HOUR);
    const text = (d.text ?? '').trim();
    if (!text || text.length > MAX_TEXT) throw new BadRequestException('bad_widget_text');
    const since = new Date();
    await this.intake.handle(s.clinicId, { channel: 'WEB', chatId: s.chatId, mid: null, text, payload: d.payload?.slice(0, 120), name: s.name });
    const replies = await this.prisma.chatMessage.findMany({ where: { clinicId: s.clinicId, channel: 'WEB', chatId: s.chatId, direction: 'OUT', createdAt: { gte: since } }, orderBy: { createdAt: 'asc' }, take: 10 });
    return { messages: this.view(replies) };
  }

  // The conversation so far (the visitor polls this to see answers of staff)
  async history(key: string, origin: string | undefined, auth: string | undefined, after?: string) {
    const s = await this.session(key, origin, auth);
    const from = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : undefined;
    const rows = await this.prisma.chatMessage.findMany({ where: { clinicId: s.clinicId, channel: 'WEB', chatId: s.chatId, ...(from ? { createdAt: { gt: from } } : {}) }, orderBy: { createdAt: 'asc' }, take: 100 });
    return { messages: this.view(rows) };
  }
}
