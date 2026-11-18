import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { RateLimitService } from '../auth/rate-limit.service';
import { normalizePhone } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import { accessBlocked, billingEnforced, hasFeature } from '../service/plans';
import { IntakeService } from './intake.service';
import { RequestsService } from './requests.service';

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
    private requests: RequestsService,
  ) {}

  private secret() {
    return `${process.env.JWT_SECRET ?? ''}:webchat`;
  }

  static normalizeOrigin(raw: string): string | null {
    try {
      const u = new URL(raw.trim());
      // a local address (http://localhost, http://127.0.0.1) only by a deliberate development setting, never in production
      const local = (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && process.env.WEBSITE_ALLOW_LOCALHOST === 'true' && process.env.NODE_ENV !== 'production';
      if (u.protocol !== 'https:' && !local) return null;
      if (!local && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return null;
      return u.origin.toLowerCase();
    } catch {
      return null;
    }
  }

  // ---- settings (the owner or manager, signed in) ----

  async settings(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true, widgetKey: true, widgetEnabled: true, widgetOrigins: true, widgetGreeting: true, widgetColor: true, widgetPosition: true, widgetVerifiedAt: true, aiWebAuto: true } });
    const site = (process.env.WEB_ORIGIN ?? '').replace(/\/$/, '');
    return {
      enabled: c.widgetEnabled,
      inPlan: hasFeature(c.plan, 'multi_channel'),
      origins: (c.widgetOrigins as string[]) ?? [],
      greeting: c.widgetGreeting,
      color: c.widgetColor,
      position: c.widgetPosition,
      // the AI answers the website chat by itself only when the owner said so (the agent's own activation and the plan still apply)
      aiAnswers: c.aiWebAuto,
      // configured is not verified: verified = a visitor's message really arrived from an allowed site
      verifiedAt: c.widgetVerifiedAt,
      snippet: c.widgetKey ? `<script src="${site}/widget.js" data-key="${c.widgetKey}" async></script>` : null,
    };
  }

  async update(clinicId: string, d: { enabled?: boolean; origins?: string[]; greeting?: string | null; color?: string | null; position?: string; aiAnswers?: boolean }) {
    const cur = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true, widgetKey: true, isDemo: true } });
    if (cur.isDemo) throw new ForbiddenException('demo_restricted');
    const data: { widgetEnabled?: boolean; widgetOrigins?: string[]; widgetGreeting?: string | null; widgetKey?: string; widgetColor?: string | null; widgetPosition?: string; aiWebAuto?: boolean } = {};
    if (d.color !== undefined) {
      if (d.color !== null && d.color !== '' && !/^#[0-9a-fA-F]{6}$/.test(d.color)) throw new BadRequestException('bad_widget_color');
      data.widgetColor = d.color ? d.color.toLowerCase() : null;
    }
    if (d.position !== undefined) {
      if (d.position !== 'RIGHT' && d.position !== 'LEFT') throw new BadRequestException('bad_widget_position');
      data.widgetPosition = d.position;
    }
    if (d.aiAnswers !== undefined) data.aiWebAuto = d.aiAnswers;
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
    const c = await this.prisma.clinic.findUnique({ where: { widgetKey: key }, select: { id: true, name: true, plan: true, widgetEnabled: true, widgetOrigins: true, widgetGreeting: true, widgetColor: true, widgetPosition: true, widgetVerifiedAt: true, aiWebAuto: true, suspendedAt: true, billingStatus: true, paidUntil: true, isDemo: true } });
    // A wrong key and a wrong site look the same
    const o = origin ? WebChatService.normalizeOrigin(origin) : null;
    if (!c || !c.widgetEnabled || !o || !((c.widgetOrigins as string[]) ?? []).includes(o)) throw new NotFoundException();
    // the plan rule of the channel is read at every call: a clinic that left Pro keeps its settings, but the chat is unavailable
    if (c.suspendedAt || (billingEnforced() && accessBlocked(c)) || !hasFeature(c.plan, 'multi_channel')) throw new ForbiddenException('webchat_unavailable');
    return c;
  }

  // Used by the controller to answer the CORS check: the site may talk to the API only if it is on the clinic's list
  async originAllowed(key: string, origin: string | undefined): Promise<boolean> {
    return this.site(key, origin).then(() => true, () => false);
  }

  async config(key: string, origin: string | undefined) {
    const c = await this.site(key, origin);
    // what the visitor needs to know: whose chat it is, the greeting, the look, and whether an AI may answer (else the staff answer when they read it)
    return { name: c.name, greeting: c.widgetGreeting, color: c.widgetColor ?? '#0e9aa0', position: c.widgetPosition === 'LEFT' ? 'LEFT' : 'RIGHT', ai: c.aiWebAuto };
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
    await this.prisma.clinic.updateMany({ where: { id: s.clinicId, widgetVerifiedAt: null }, data: { widgetVerifiedAt: since } });
    await this.intake.handle(s.clinicId, { channel: 'WEB', chatId: s.chatId, mid: null, text, payload: d.payload?.slice(0, 120), name: s.name });
    const replies = await this.prisma.chatMessage.findMany({ where: { clinicId: s.clinicId, channel: 'WEB', chatId: s.chatId, direction: 'OUT', createdAt: { gte: since } }, orderBy: { createdAt: 'asc' }, take: 10 });
    return { messages: this.view(replies) };
  }

  // "I want a person": the dialogue becomes a staff member's at once (the AI stops answering it), one request for the staff, and the visitor is told what
  // happens next without a promised time. Repeated presses make no second request.
  async handoff(key: string, origin: string | undefined, auth: string | undefined, ip: string) {
    const s = await this.session(key, origin, auth);
    await this.limits.consume(`webchat:msg:${s.chatId}`, 20, 10 * 60_000);
    await this.limits.consume(`webchat:ip:${ip}`, 80, HOUR);
    const { clinicId, chatId } = s;
    const since = new Date();
    await this.prisma.conversationState.upsert({ where: { clinicId_channel_chatId: { clinicId, channel: 'WEB', chatId } }, create: { clinicId, channel: 'WEB', chatId, owner: 'HUMAN' }, update: { owner: 'HUMAN' } });
    await this.prisma.chatMessage.create({ data: { clinicId, channel: 'WEB', chatId, direction: 'IN', text: 'Прошу з’єднати з адміністратором', contactName: s.name } });
    await this.requests.upsert(clinicId, { channel: 'WEB', chatId, patientId: null, contactName: s.name, kind: 'HANDOFF', summary: 'Відвідувач сайту попросив співробітника' });
    await this.prisma.chatMessage.create({ data: { clinicId, channel: 'WEB', chatId, direction: 'OUT', text: 'Передали ваше прохання адміністраторам клініки. Далі вам відповідає людина; відповідь з’явиться в цьому вікні, щойно адміністратор його прочитає.' } });
    const rows = await this.prisma.chatMessage.findMany({ where: { clinicId, channel: 'WEB', chatId, direction: 'OUT', createdAt: { gte: since } }, orderBy: { createdAt: 'asc' }, take: 10 });
    return { messages: this.view(rows) };
  }

  // The conversation so far (the visitor polls this to see answers of staff)
  async history(key: string, origin: string | undefined, auth: string | undefined, after?: string) {
    const s = await this.session(key, origin, auth);
    await this.limits.consume(`webchat:poll:${s.chatId}`, 300, 10 * 60_000);
    const from = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : undefined;
    const rows = await this.prisma.chatMessage.findMany({ where: { clinicId: s.clinicId, channel: 'WEB', chatId: s.chatId, ...(from ? { createdAt: { gt: from } } : {}) }, orderBy: { createdAt: 'asc' }, take: 100 });
    return { messages: this.view(rows) };
  }
}
