import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { clinicDate, clinicHm, localToUtc } from '../common/clinic-time';
import { PrismaService } from '../prisma/prisma.service';
import { accessBlocked, billingEnforced, launchPending } from '../service/plans';
import { AgentAutoGate } from './agent-auto-gate';
import { SendError } from './channels';
import { MessengerService } from './messenger.service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Follow-ups go to the agent's dialogues in these channels
export const FOLLOW_UP_CHANNELS = ['INSTAGRAM', 'MESSENGER', 'TELEGRAM'];
// Instagram and Messenger: a business may write only within 24 hours of the person's last message (Meta's standard messaging window)
const META_WINDOW_MS = 24 * HOUR;
const WINDOW_CHANNELS = ['INSTAGRAM', 'MESSENGER'];
// A dialogue is looked at once it has been quiet this long (the agent's last message unanswered)
const QUIET_MS = 3 * HOUR;
// Dialogues older than this are not followed up any more (a follow-up a week later is not "the next day")
const LOOK_BACK_MS = 3 * DAY;
// Clinic daytime for messages to patients (Kyiv time): from 10:00, the last one at 19:00
const DAY_FROM = 10;
const DAY_TO = 19;
// The stages where the agent was still talking (anything else: booked, handed to a person, declined, closed)
const OPEN_STAGES = ['NEW', 'DISCOVERY', 'OFFERED'];
// A planned or pending follow-up is valid this long after its time
const STALE_MS = 6 * HOUR;
export const FOLLOW_UP_DAYS: [number, number] = [1, 14];
export type FollowUpReason = 'PRICE' | 'TIME' | 'SILENT';
type TextKey = FollowUpReason | 'AGAIN';
type Lang = 'uk' | 'ru';

// The default texts: no name, no medical detail, nothing the agent did not offer; the clinic edits them in the settings
export const FOLLOW_UP_DEFAULTS: Record<TextKey, Record<Lang, string>> = {
  PRICE: {
    uk: 'Добрий день! Ви цікавилися вартістю. Якщо зручно, підберу для вас час візиту — напишіть, який день вам підходить.',
    ru: 'Добрый день! Вы интересовались стоимостью. Если удобно, подберу для вас время визита — напишите, какой день вам подходит.',
  },
  TIME: {
    uk: 'Добрий день! Минулого разу запропонований час вам не підійшов. Напишіть, які день і час вам зручні, — запропоную інші вільні вікна.',
    ru: 'Добрый день! В прошлый раз предложенное время вам не подошло. Напишите, какие день и время вам удобны, — предложу другие свободные окна.',
  },
  SILENT: {
    uk: 'Добрий день! Нагадую про нашу розмову. Якщо питання ще актуальне, напишіть — допоможу з записом.',
    ru: 'Добрый день! Напоминаю о нашем разговоре. Если вопрос ещё актуален, напишите — помогу с записью.',
  },
  AGAIN: {
    uk: 'Добрий день! Будемо раді бачити вас у клініці. Якщо захочете записатися, просто напишіть сюди — підберемо зручний час.',
    ru: 'Добрый день! Будем рады видеть вас в клинике. Если захотите записаться, просто напишите сюда — подберём удобное время.',
  },
};

const localHour = (d: Date) => Number(clinicHm(d).slice(0, 2));
// The given clinic day at hh:00 (Kyiv)
const atHour = (day: Date, h: number) => localToUtc(`${clinicDate(day)} ${String(h).padStart(2, '0')}:00:00`);

// The latest daytime moment within [from, to], or null (the whole range is night)
export function latestDaytime(from: Date, to: Date): Date | null {
  for (let t = to.getTime(); t >= from.getTime(); t -= 15 * 60_000) {
    const d = new Date(t);
    const h = localHour(d);
    if (h >= DAY_FROM && h < DAY_TO) return d;
  }
  return null;
}

// The next day after `after` at 11:00 Kyiv (at least 12 hours later)
function nextDayMorning(after: Date): Date {
  let d = atHour(new Date(after.getTime() + DAY), 11);
  if (d.getTime() - after.getTime() < 12 * HOUR) d = atHour(new Date(after.getTime() + 2 * DAY), 11);
  return d;
}

// The patient's language from their last messages: Russian only with clear Russian letters and no Ukrainian ones
export function guessLang(texts: string[]): Lang {
  const s = texts.join(' ').toLowerCase();
  if (/[іїєґ]/.test(s)) return 'uk';
  if (/[ыэъё]/.test(s)) return 'ru';
  return 'uk';
}

@Injectable()
export class FollowUpService {
  private readonly log = new Logger(FollowUpService.name);

  constructor(
    private prisma: PrismaService,
    private messenger: MessengerService,
    private gate: AgentAutoGate,
  ) {}

  // ---------- settings ----------

  async settings(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { followUpEnabled: true, followUpDays: true, followUpTexts: true, sendingEnabled: true } });
    const own = (c.followUpTexts ?? {}) as Partial<Record<TextKey, Partial<Record<Lang, string>>>>;
    const texts = Object.fromEntries((Object.keys(FOLLOW_UP_DEFAULTS) as TextKey[]).map((k) => [k, { uk: own[k]?.uk ?? FOLLOW_UP_DEFAULTS[k].uk, ru: own[k]?.ru ?? FOLLOW_UP_DEFAULTS[k].ru }]));
    return { enabled: c.followUpEnabled, days: c.followUpDays, texts, defaults: FOLLOW_UP_DEFAULTS, sendingEnabled: c.sendingEnabled };
  }

  async updateSettings(clinicId: string, userId: string, d: { enabled?: boolean; days?: number; texts?: Partial<Record<TextKey, Partial<Record<Lang, string>>>> }) {
    if (d.days !== undefined && !(Number.isInteger(d.days) && d.days >= FOLLOW_UP_DAYS[0] && d.days <= FOLLOW_UP_DAYS[1])) throw new BadRequestException('bad_follow_up');
    let texts: Prisma.InputJsonValue | undefined;
    if (d.texts) {
      const out: Record<string, Record<string, string>> = {};
      for (const k of Object.keys(FOLLOW_UP_DEFAULTS) as TextKey[]) {
        for (const l of ['uk', 'ru'] as Lang[]) {
          const v = d.texts[k]?.[l];
          if (v === undefined) continue;
          const t = String(v).trim();
          if (!t || t.length > 500) throw new BadRequestException('bad_follow_up');
          (out[k] ??= {})[l] = t;
        }
      }
      const cur = ((await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { followUpTexts: true } })).followUpTexts ?? {}) as Record<string, Record<string, string>>;
      for (const [k, v] of Object.entries(out)) cur[k] = { ...(cur[k] ?? {}), ...v };
      texts = cur;
    }
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { ...(d.enabled !== undefined ? { followUpEnabled: d.enabled } : {}), ...(d.days !== undefined ? { followUpDays: d.days } : {}), ...(texts ? { followUpTexts: texts } : {}) } });
    // switched off: nothing planned is sent any more
    if (d.enabled === false) await this.prisma.followUp.updateMany({ where: { clinicId, status: { in: ['PLANNED', 'PENDING_APPROVAL'] } }, data: { status: 'CANCELLED', error: 'switched_off' } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'followup.settings', details: { enabled: d.enabled, days: d.days, texts: d.texts ? Object.keys(d.texts) : undefined } } });
    return this.settings(clinicId);
  }

  // ---------- the list for the staff ----------

  async list(clinicId: string) {
    const rows = await this.prisma.followUp.findMany({ where: { clinicId }, orderBy: [{ dueAt: 'desc' }], take: 200 });
    const names = new Map<string, string | null>();
    for (const r of rows) {
      const k = `${r.channel}|${r.chatId}`;
      if (names.has(k)) continue;
      const m = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel: r.channel, chatId: r.chatId, contactName: { not: null } }, orderBy: { createdAt: 'desc' }, select: { contactName: true } });
      names.set(k, m?.contactName ?? null);
    }
    return rows.map((r) => ({ id: r.id, channel: r.channel, chatId: r.chatId, name: names.get(`${r.channel}|${r.chatId}`) ?? null, reason: r.reason, step: r.step, text: r.text, dueAt: r.dueAt, expiresAt: r.expiresAt, status: r.status, sentAt: r.sentAt, error: r.error }));
  }

  // ---------- planning ----------

  // Every clinic with follow-ups on: plan what is due, cancel what is no longer valid, send what may go out now
  async tick(now = new Date()) {
    const clinics = await this.prisma.clinic.findMany({ where: { followUpEnabled: true, suspendedAt: null }, select: { id: true } });
    for (const c of clinics) {
      await this.plan(c.id, now).catch((e) => this.log.warn(`Follow-ups plan: ${(e as Error).message}`));
      await this.process(c.id, now).catch((e) => this.log.warn(`Follow-ups send: ${(e as Error).message}`));
    }
  }

  // Why the dialogue stopped, or null when there is nothing to follow up (booked, handed over, a human owns it, the patient wrote last, ...)
  private async reasonOf(clinicId: string, channel: string, chatId: string, stage: string, now: Date) {
    const last = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, error: null }, orderBy: { createdAt: 'desc' }, select: { direction: true, createdAt: true } });
    const lastIn = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true } });
    if (!last || !lastIn || last.direction !== 'OUT') return null;
    if (now.getTime() - last.createdAt.getTime() < QUIET_MS) return null;
    if (now.getTime() - lastIn.createdAt.getTime() > LOOK_BACK_MS) return null;
    // an open request (a booking, a move, a hand-over to a person) is the staff's now
    if (await this.prisma.bookingRequest.count({ where: { clinicId, channel, chatId, status: 'NEW' } })) return null;
    // the patient has a visit ahead (booked here or elsewhere), opted out, or the dialogue was booked through LANKA
    const link = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { optedOutAt: true, patientId: true } });
    if (link?.optedOutAt) return null;
    if (link?.patientId && (await this.prisma.visit.count({ where: { clinicId, patientId: link.patientId, startsAt: { gt: now }, status: { notIn: ['CANCELLED', 'DID_NOT_COME', 'MOVED'] } } }))) return null;
    if (await this.prisma.funnelEvent.count({ where: { clinicId, kind: 'BOOKED', conversation: { channel, chatId } } })) return null;
    let reason: FollowUpReason = 'SILENT';
    if (stage === 'OFFERED') reason = 'TIME';
    else {
      const sent = await this.prisma.agentDraft.findFirst({ where: { clinicId, channel, chatId, status: 'SENT' }, orderBy: { updatedAt: 'desc' }, select: { snapshot: true } });
      const prices = ((sent?.snapshot as { exec?: { prices?: unknown[] } } | null)?.exec?.prices ?? []) as unknown[];
      if (prices.length) reason = 'PRICE';
    }
    const recent = await this.prisma.chatMessage.findMany({ where: { clinicId, channel, chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, take: 5, select: { text: true } });
    return { reason, lastIn, lastOut: last.createdAt, lang: guessLang(recent.map((m) => m.text)) };
  }

  async plan(clinicId: string, now = new Date()) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { followUpEnabled: true, followUpDays: true, followUpTexts: true } });
    if (!c.followUpEnabled) return 0;
    const own = (c.followUpTexts ?? {}) as Partial<Record<TextKey, Partial<Record<Lang, string>>>>;
    const text = (k: TextKey, l: Lang) => own[k]?.[l] ?? FOLLOW_UP_DEFAULTS[k][l];
    const states = await this.prisma.conversationState.findMany({ where: { clinicId, channel: { in: FOLLOW_UP_CHANNELS }, salesStage: { in: OPEN_STAGES }, owner: 'BOT', updatedAt: { gt: new Date(now.getTime() - LOOK_BACK_MS - DAY) } }, select: { channel: true, chatId: true, salesStage: true } });
    let made = 0;
    for (const st of states) {
      const r = await this.reasonOf(clinicId, st.channel, st.chatId, st.salesStage, now);
      if (!r) continue;
      const steps: { step: number; dueAt: Date | null; expiresAt: Date | null; key: TextKey }[] = [];
      if (WINDOW_CHANNELS.includes(st.channel)) {
        // one message inside Meta's window: the latest daytime moment between 16 and 23 hours after the patient's last message
        const closes = new Date(r.lastIn.createdAt.getTime() + META_WINDOW_MS);
        const at = latestDaytime(new Date(Math.max(r.lastIn.createdAt.getTime() + 16 * HOUR, r.lastOut.getTime() + QUIET_MS)), new Date(closes.getTime() - HOUR));
        steps.push({ step: 1, dueAt: at, expiresAt: new Date(closes.getTime() - 15 * 60_000), key: r.reason });
      } else {
        const first = nextDayMorning(r.lastOut);
        steps.push({ step: 1, dueAt: first, expiresAt: new Date(first.getTime() + STALE_MS), key: r.reason });
        const second = atHour(new Date(first.getTime() + c.followUpDays * DAY), 11);
        steps.push({ step: 2, dueAt: second, expiresAt: new Date(second.getTime() + STALE_MS), key: 'AGAIN' });
      }
      for (const s of steps) {
        if (!s.dueAt) continue; // the whole window is night: nothing automatic, the dialogue stays for a person
        const res = await this.prisma.followUp.createMany({
          data: [{ clinicId, channel: st.channel, chatId: st.chatId, reason: r.reason, step: s.step, lang: r.lang, text: text(s.key, r.lang), dueAt: s.dueAt, expiresAt: s.expiresAt, basisMessageId: r.lastIn.id }],
          skipDuplicates: true,
        });
        made += res.count;
      }
    }
    return made;
  }

  // ---------- sending ----------

  // Is this follow-up still right to send: the patient wrote nothing new, nothing was booked, the window is open
  private async stillValid(f: { clinicId: string; channel: string; chatId: string; basisMessageId: string; expiresAt: Date | null }, now: Date): Promise<string | null> {
    const lastIn = await this.prisma.chatMessage.findFirst({ where: { clinicId: f.clinicId, channel: f.channel, chatId: f.chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (lastIn?.id !== f.basisMessageId) return 'patient_wrote';
    if (f.expiresAt && now > f.expiresAt) return 'expired';
    const st = await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId: f.clinicId, channel: f.channel, chatId: f.chatId } }, select: { salesStage: true, owner: true } });
    if (!st || !OPEN_STAGES.includes(st.salesStage) || st.owner !== 'BOT') return 'dialogue_changed';
    if (await this.prisma.bookingRequest.count({ where: { clinicId: f.clinicId, channel: f.channel, chatId: f.chatId, status: 'NEW' } })) return 'request_open';
    if (await this.prisma.funnelEvent.count({ where: { clinicId: f.clinicId, kind: 'BOOKED', conversation: { channel: f.channel, chatId: f.chatId } } })) return 'booked';
    const link = await this.prisma.patientChannel.findFirst({ where: { clinicId: f.clinicId, channel: f.channel, externalId: f.chatId }, select: { optedOutAt: true } });
    if (link?.optedOutAt) return 'opted_out';
    if (!(await this.messenger.windowOpenAt(f.clinicId, f.channel, f.chatId, now))) return 'window_closed';
    return null;
  }

  // The clinic may send now: the master switch, the paid period, not suspended
  private async clinicMaySend(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { sendingEnabled: true, followUpEnabled: true, suspendedAt: true, billingStatus: true, paidUntil: true, isDemo: true, plan: true } });
    return c.followUpEnabled && c.sendingEnabled && !c.suspendedAt && !launchPending(c) && !(billingEnforced() && accessBlocked(c));
  }

  // Due follow-ups: invalid ones are cancelled; in a dialogue the agent answers on its own the message goes out; otherwise it waits for a staff member
  async process(clinicId: string, now = new Date()) {
    const due = await this.prisma.followUp.findMany({ where: { clinicId, status: { in: ['PLANNED', 'PENDING_APPROVAL'] }, dueAt: { lte: now } }, orderBy: { dueAt: 'asc' }, take: 50 });
    let sent = 0;
    for (const f of due) {
      const why = await this.stillValid(f, now);
      if (why) {
        await this.prisma.followUp.updateMany({ where: { id: f.id, status: f.status }, data: { status: why === 'expired' || why === 'window_closed' ? 'EXPIRED' : 'CANCELLED', error: why } });
        continue;
      }
      if (f.status !== 'PLANNED') continue;
      const auto = (await this.gate.denied(clinicId, f.channel, f.chatId)) === null;
      if (!auto) {
        await this.prisma.followUp.updateMany({ where: { id: f.id, status: 'PLANNED' }, data: { status: 'PENDING_APPROVAL' } });
        continue;
      }
      if (!(await this.clinicMaySend(clinicId))) continue;
      if ((await this.deliver(f.id, null, now)) === 'SENT') sent++;
    }
    return sent;
  }

  // A staff member sends a waiting follow-up now (or one planned for later); checked again right before sending
  async sendNow(clinicId: string, userId: string, id: string) {
    const f = await this.prisma.followUp.findFirst({ where: { id, clinicId } });
    if (!f) throw new NotFoundException('follow_up_not_found');
    if (!['PLANNED', 'PENDING_APPROVAL'].includes(f.status)) throw new BadRequestException('follow_up_not_open');
    const why = await this.stillValid(f, new Date());
    if (why) {
      await this.prisma.followUp.updateMany({ where: { id, status: f.status }, data: { status: why === 'expired' || why === 'window_closed' ? 'EXPIRED' : 'CANCELLED', error: why } });
      throw new BadRequestException(`follow_up_${why}`);
    }
    if (!(await this.clinicMaySend(clinicId))) throw new BadRequestException('sending_disabled');
    const outcome = await this.deliver(id, userId, new Date());
    if (outcome !== 'SENT') throw new BadRequestException('send_failed');
    return { ok: true };
  }

  async cancel(clinicId: string, userId: string, id: string) {
    const r = await this.prisma.followUp.updateMany({ where: { id, clinicId, status: { in: ['PLANNED', 'PENDING_APPROVAL'] } }, data: { status: 'CANCELLED', error: 'by_staff', approvedById: userId } });
    if (!r.count) throw new NotFoundException('follow_up_not_found');
    return { ok: true };
  }

  // Claim, send through the channel, record the outgoing message; a failure is recorded and never retried blindly
  private async deliver(id: string, userId: string | null, now: Date): Promise<'SENT' | 'FAILED' | 'SKIPPED'> {
    const claim = await this.prisma.followUp.updateMany({ where: { id, status: { in: ['PLANNED', 'PENDING_APPROVAL'] } }, data: { status: 'SENDING', approvedById: userId } });
    if (!claim.count) return 'SKIPPED';
    const f = await this.prisma.followUp.findUniqueOrThrow({ where: { id } });
    const link = await this.prisma.patientChannel.findFirst({ where: { clinicId: f.clinicId, channel: f.channel, externalId: f.chatId }, select: { patientId: true } });
    const base = { clinicId: f.clinicId, channel: f.channel, chatId: f.chatId, direction: 'OUT', text: f.text, authorUserId: userId, patientId: link?.patientId ?? null };
    try {
      await this.messenger.send(f.clinicId, f.channel, f.chatId, f.text);
    } catch (e) {
      const reason = e instanceof SendError ? e.message.slice(0, 200) : 'send_failed';
      if (e instanceof SendError && e.blocked) await this.prisma.patientChannel.updateMany({ where: { clinicId: f.clinicId, channel: f.channel, externalId: f.chatId }, data: { optedOutAt: now } });
      await this.prisma.followUp.update({ where: { id }, data: { status: e instanceof SendError && e.reason === 'window_closed' ? 'EXPIRED' : 'FAILED', error: reason } });
      return 'FAILED';
    }
    const msg = await this.prisma.chatMessage.create({ data: base });
    await this.prisma.followUp.update({ where: { id }, data: { status: 'SENT', sentAt: now, messageId: msg.id, error: null } });
    await this.prisma.auditLog.create({ data: { clinicId: f.clinicId, userId, action: 'followup.sent', details: { id, channel: f.channel, reason: f.reason, step: f.step, auto: !userId } } });
    return 'SENT';
  }
}
