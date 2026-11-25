import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';
import { accessBlocked, billingEnforced, hasFeature } from '../service/plans';

export type PushLang = 'uk' | 'ru' | 'en';
// What a device shows: a short title and body, the page to open, a tag (the same tag replaces an earlier notification instead of adding one)
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
  // the opaque key of the person this copy is for: the device shows it (and opens its page) only while that person is the device's Push owner,
  // so a notification arriving after a sign-out, even an offline one, is not shown to whoever uses the device next
  u?: string;
}
// The options of one send: TTL = how long the push service keeps an undelivered message (an old notification never arrives days later)
export interface PushOptions {
  ttl: number;
}

// The real sender; replaced with a fake in tests so nothing leaves the machine. The private VAPID key stays in the server's environment.
@Injectable()
export class PushSender {
  get configured() {
    return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  }

  async send(sub: { endpoint: string; p256dh: string; auth: string }, payload: PushPayload, opts: PushOptions) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: opts.ttl, urgency: 'normal' });
  }
}

// The roles a clinic event may reach, by event
export const PUSH_ROLES = { requests: ['OWNER', 'MANAGER', 'ADMIN'], signals: ['OWNER', 'MANAGER'] };
const TEST_GAP_MS = 60_000;
const MAX_DEVICES = 10;
const T: Record<PushLang, { test: string; testBody: string }> = {
  uk: { test: 'LANKA · Сповіщення працюють', testBody: 'Тестове сповіщення лише на цей пристрій.' },
  ru: { test: 'LANKA · Уведомления работают', testBody: 'Тестовое уведомление только на это устройство.' },
  en: { test: 'LANKA · Notifications work', testBody: 'A test notification to this device only.' },
};
export const pushLang = (l?: string | null): PushLang => (l === 'ru' || l === 'en' ? l : 'uk');
// "/open" checks the clinic of the session first (another clinic: the safe switch; no access: a refusal without data), then opens `to`
export const pushUrl = (clinicId: string, to: string) => `/open?c=${encodeURIComponent(clinicId)}&to=${encodeURIComponent(to)}`;

// Push notifications to the devices of the staff (2026-11-25). One row per device of one person; the clinic, the role, the plan and the billing are
// checked at every send, never taken from the moment the device was switched on.
@Injectable()
export class PushService {
  private readonly log = new Logger(PushService.name);
  private testSent = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private sender: PushSender,
  ) {}

  get available() {
    return this.sender.configured;
  }

  publicKey() {
    return process.env.VAPID_PUBLIC_KEY ?? null;
  }

  // An opaque key of the person (no id leaves the server): the device remembers who switched it on, so another person signing in on it is noticed
  userKey(userId: string) {
    return createHash('sha256').update(`push:${userId}`).digest('base64url').slice(0, 16);
  }

  // The state of THIS device for the signed-in person: mine (a subscription of this person), other (of somebody else: the device changed hands),
  // none. The endpoint comes in the body, never in an address. For "other", holderKey is the holder's opaque key: the device queues the removal
  // of exactly that holder's row (see release), never a row that is or becomes the current person's.
  async device(userId: string, endpoint?: string) {
    let device: 'mine' | 'other' | 'none' = 'none';
    let holderKey: string | undefined;
    if (endpoint) {
      const row = await this.prisma.pushSubscription.findUnique({ where: { endpoint }, select: { userId: true } });
      device = !row ? 'none' : row.userId === userId ? 'mine' : 'other';
      if (row && device === 'other') holderKey = this.userKey(row.userId);
    }
    return { available: this.available, publicKey: this.publicKey(), device, userKey: this.userKey(userId), ...(holderKey ? { holderKey } : {}) };
  }

  // Switching on (or again) on this device: one row per endpoint. A device that belonged to another person is taken over (only the device itself
  // knows its endpoint); the moment of switching on is new then, so nothing older reaches the new owner.
  async subscribe(clinicId: string, userId: string, sub: { endpoint: string; p256dh: string; auth: string }, lang: PushLang) {
    if (!this.available) throw new BadRequestException('push_not_configured');
    if (!/^https:\/\//.test(sub.endpoint)) throw new BadRequestException('bad_push_endpoint');
    const cur = await this.prisma.pushSubscription.findUnique({ where: { endpoint: sub.endpoint }, select: { userId: true } });
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { clinicId, userId, ...sub, lang },
      update: { p256dh: sub.p256dh, auth: sub.auth, lang, ...(cur?.userId !== userId ? { userId, clinicId, enabledAt: new Date() } : {}) },
    });
    // a person's oldest devices beyond the limit are dropped
    const mine = await this.prisma.pushSubscription.findMany({ where: { userId }, orderBy: { enabledAt: 'desc' }, select: { id: true } });
    if (mine.length > MAX_DEVICES) await this.prisma.pushSubscription.deleteMany({ where: { id: { in: mine.slice(MAX_DEVICES).map((m) => m.id) } } });
    return this.device(userId, sub.endpoint);
  }

  // Switching off this device (also at sign-out): only the signed-in person's own row of THIS endpoint goes; the person's other devices and
  // anybody else's rows are untouched. After this the server sends nothing there. (A device left with someone else's subscription unsubscribes
  // in the browser; the push service then answers 410 and the row is deleted at the next send.)
  async unsubscribe(userId: string, endpoint: string) {
    const r = await this.prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
    return { removed: r.count, ...(await this.device(userId, endpoint)) };
  }

  // A sign-out that could not reach the server (offline): the device sends it later WITHOUT a session (the session is gone by then). The endpoint
  // itself is the proof (only that browser and this server know it), and `u` names whose subscription it was: the row is removed only while it
  // still belongs to that person. If the same endpoint has been switched on by someone else (or again) since, it is left alone. Nothing is
  // read or returned.
  async release(endpoint: string, u: string) {
    const row = await this.prisma.pushSubscription.findUnique({ where: { endpoint }, select: { id: true, userId: true } });
    if (row && this.userKey(row.userId) === u) await this.prisma.pushSubscription.deleteMany({ where: { id: row.id, userId: row.userId } });
    return { ok: true };
  }

  // The browser renewed the subscription (pushsubscriptionchange): the person's row moves to the new endpoint
  async renew(userId: string, oldEndpoint: string, sub: { endpoint: string; p256dh: string; auth: string }) {
    if (!/^https:\/\//.test(sub.endpoint)) throw new BadRequestException('bad_push_endpoint');
    const old = await this.prisma.pushSubscription.findUnique({ where: { endpoint: oldEndpoint } });
    if (!old || old.userId !== userId) throw new NotFoundException('push_not_found');
    await this.prisma.$transaction([
      this.prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint, NOT: { id: old.id } } }),
      this.prisma.pushSubscription.update({ where: { id: old.id }, data: { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth } }),
    ]);
    return { ok: true };
  }

  // The test: only to THIS device of the signed-in person, at most once a minute
  async test(userId: string, endpoint: string) {
    const sub = await this.prisma.pushSubscription.findUnique({ where: { endpoint } });
    if (!sub || sub.userId !== userId) throw new NotFoundException('push_not_found');
    if (!this.available) return { sent: 0 };
    const last = this.testSent.get(userId) ?? 0;
    if (Date.now() - last < TEST_GAP_MS) throw new BadRequestException('too_often');
    this.testSent.set(userId, Date.now());
    const t = T[pushLang(sub.lang)];
    const ok = await this.deliver(sub, { title: t.test, body: t.testBody, url: '/settings#push', tag: 'test', u: this.userKey(sub.userId) }, { ttl: 300 });
    return { sent: ok ? 1 : 0 };
  }

  // A clinic event to the devices of the people who may see it NOW: members of the clinic with one of `roles` (a lost role or membership
  // receives nothing), the clinic not suspended or locked by billing, the plan having `feature` when given. notBefore: a device switched on
  // after the event never gets it (nothing accumulated). The text is built per device language and carries no patient data. One device's failure
  // never stops the others; a subscription the push service reports gone (404/410) is deleted. Returns the number accepted by the push service.
  async notify(clinicId: string, text: (lang: PushLang, clinic: string) => { title: string; body: string }, o: { url: string; tag?: string; roles: string[]; ttl: number; notBefore?: Date; feature?: Parameters<typeof hasFeature>[1] }) {
    if (!this.available) return 0;
    const c = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { name: true, suspendedAt: true, isDemo: true, billingStatus: true, paidUntil: true, plan: true } });
    if (!c || c.suspendedAt || (billingEnforced() && accessBlocked(c))) return 0;
    if (o.feature && !hasFeature(c.plan, o.feature)) return 0;
    const people = (await this.prisma.membership.findMany({ where: { clinicId, role: { in: o.roles as never } }, select: { userId: true } })).map((m) => m.userId);
    if (!people.length) return 0;
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId: { in: people }, ...(o.notBefore ? { enabledAt: { lte: o.notBefore } } : {}) } });
    let sent = 0;
    for (const s of subs) {
      const t = text(pushLang(s.lang), c.name);
      if (await this.deliver(s, { ...t, url: pushUrl(clinicId, o.url), tag: o.tag, u: this.userKey(s.userId) }, { ttl: o.ttl })) sent++;
    }
    return sent;
  }

  private async deliver(s: { id: string; endpoint: string; p256dh: string; auth: string }, payload: PushPayload, opts: PushOptions) {
    try {
      await this.sender.send(s, payload, opts);
      return true;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 404/410: the subscription no longer exists (the app was removed, permission withdrawn, the browser renewed it)
      if (code === 404 || code === 410) await this.prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
      // the status only: neither the endpoint nor the push service's answer goes to the log
      else this.log.warn(`Push not delivered (status ${code ?? 'network'})`);
      return false;
    }
  }
}
