import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { hashToken, newToken } from '../auth/tokens';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramApi, TelegramError, TgUpdate } from './telegram.api';

// The shared LANKA service bot for managers (2026-11-23): reports and signals of any clinic, independent of the clinic's own patient bot.
// Set up once by the platform owner on the server: LANKA_TG_BOT_TOKEN, LANKA_TG_BOT_USERNAME and LANKA_TG_WEBHOOK_SECRET (the token never
// reaches a browser or the log; TelegramApi keeps it out of error messages). A clinic neither creates nor enters anything.
//
// Linking: the signed-in owner or manager asks for a one-time link (a random token, 15 minutes, stored only as a hash, tied on the server to
// that user and clinic; nothing personal in the address). Opening it and pressing Start shows a confirmation with the clinic and the account;
// only the button in a PRIVATE chat links that Telegram account. Nobody can be linked by a phone, a username or a chat id.
const LINK_TTL = 15 * 60_000;
export const LEADER_ROLES = ['OWNER', 'MANAGER'];
type Lang = 'uk' | 'ru' | 'en';

const T: Record<Lang, Record<string, string>> = {
  uk: {
    confirm: 'Підключити цей Telegram для звітів і сигналів клініки «{c}» в обліковому записі {u}?\n\nПацієнти цього бота не бачать і сюди не пишуть.',
    yes: 'Підключити',
    done: 'Готово: цей Telegram підключено для клініки «{c}». Оберіть у кабінеті LANKA, що надсилати сюди: дайджест і (або) сигнали.',
    bad: 'Посилання недійсне, уже використане або застаріло. Створіть нове в кабінеті LANKA: Налаштування → Загальні → Telegram для звітів і сигналів.',
    group: 'Підключення працює лише в особистому чаті з ботом.',
    taken: 'Цей Telegram уже підключено для іншого користувача клініки «{c}».',
    other: 'Для вашого облікового запису в клініці «{c}» уже підключено інший Telegram. Спершу відключіть його в кабінеті LANKA.',
    noRole: 'Підключення доступне лише власнику й керуючому клініки.',
    hello: 'Це службовий бот LANKA для звітів і сигналів керівникам клінік. Підключіться з кабінету LANKA: Налаштування → Загальні → Telegram для звітів і сигналів.',
  },
  ru: {
    confirm: 'Подключить этот Telegram для отчётов и сигналов клиники «{c}» в учётной записи {u}?\n\nПациенты этого бота не видят и сюда не пишут.',
    yes: 'Подключить',
    done: 'Готово: этот Telegram подключён для клиники «{c}». Выберите в кабинете LANKA, что присылать сюда: дайджест и (или) сигналы.',
    bad: 'Ссылка недействительна, уже использована или устарела. Создайте новую в кабинете LANKA: Настройки → Общие → Telegram для отчётов и сигналов.',
    group: 'Подключение работает только в личном чате с ботом.',
    taken: 'Этот Telegram уже подключён для другого пользователя клиники «{c}».',
    other: 'Для вашей учётной записи в клинике «{c}» уже подключён другой Telegram. Сначала отключите его в кабинете LANKA.',
    noRole: 'Подключение доступно только владельцу и управляющему клиники.',
    hello: 'Это служебный бот LANKA для отчётов и сигналов руководителям клиник. Подключитесь из кабинета LANKA: Настройки → Общие → Telegram для отчётов и сигналов.',
  },
  en: {
    confirm: 'Connect this Telegram for reports and signals of the clinic “{c}” in the account {u}?\n\nPatients do not see this bot and do not write here.',
    yes: 'Connect',
    done: 'Done: this Telegram is connected for the clinic “{c}”. Choose in the LANKA workspace what comes here: the digest and/or signals.',
    bad: 'The link is invalid, already used or expired. Create a new one in the LANKA workspace: Settings → General → Telegram for reports and signals.',
    group: 'Connecting works only in a private chat with the bot.',
    taken: 'This Telegram is already connected for another user of the clinic “{c}”.',
    other: 'Another Telegram is already connected for your account in the clinic “{c}”. Disconnect it in the LANKA workspace first.',
    noRole: 'Only the owner and the manager of the clinic can connect.',
    hello: 'This is the LANKA service bot for clinic managers’ reports and signals. Connect from the LANKA workspace: Settings → General → Telegram for reports and signals.',
  },
};
const langOf = (code?: string): Lang => (code?.startsWith('ru') ? 'ru' : code?.startsWith('en') ? 'en' : 'uk');
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

export type LeaderKind = 'digest' | 'signals' | 'weekly' | 'monthly' | 'legacyWeekly';

@Injectable()
export class LeaderTelegramService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(LeaderTelegramService.name);
  private timer?: NodeJS.Timeout;
  private polling = false;
  private offset = 0;

  constructor(
    private prisma: PrismaService,
    private api: TelegramApi,
  ) {}

  private get token() {
    return process.env.LANKA_TG_BOT_TOKEN?.trim() || null;
  }
  private get username() {
    return process.env.LANKA_TG_BOT_USERNAME?.trim().replace(/^@/, '') || null;
  }
  // the service bot is set up on this server
  get available() {
    return !!(this.token && this.username);
  }

  // Development: the server is not reachable from the internet, so the service bot polls by itself. Production: the webhook below.
  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'production' || process.env.TELEGRAM_POLL === 'false' || !this.available) return;
    this.timer = setInterval(() => void this.poll(), 3000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll() {
    if (this.polling || !this.token) return;
    this.polling = true;
    try {
      const updates = await this.api.getUpdates(this.token, this.offset ? this.offset + 1 : undefined);
      for (const u of updates) {
        this.offset = Math.max(this.offset, u.update_id);
        await this.handle(u).catch((e) => this.log.warn(`Службовий бот: ${(e as Error).message}`));
      }
    } catch (e) {
      if (!(e instanceof TelegramError)) this.log.warn(`Службовий бот: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  // Production webhook: Telegram repeats the secret set with setWebhook in a header; anything else is ignored silently
  async webhook(header: string | undefined, update: TgUpdate) {
    const secret = process.env.LANKA_TG_WEBHOOK_SECRET?.trim();
    if (!secret || !this.available) return;
    const a = Buffer.from(header ?? '');
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return;
    await this.handle(update);
  }

  // ---------- the workspace ----------

  // The person's own connection for this clinic, who receives what (names only), and the legacy routes of the clinic's patient bot
  async view(clinicId: string, userId: string) {
    const [me, people, legacy, staff] = await Promise.all([
      this.prisma.leaderTelegram.findUnique({ where: { clinicId_userId: { clinicId, userId } } }),
      this.recipients(clinicId),
      this.prisma.digestRecipient.findMany({ where: { clinicId, migratedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } }),
      this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: 'TELEGRAM' } }, select: { apiKeyEnc: true, config: true } }),
    ]);
    const { digestFrequency, legacyWeeklyOn } = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { digestFrequency: true, legacyWeeklyOn: true } });
    const group = staff?.apiKeyEnc ? ((staff.config ?? {}) as { staffChat?: { title: string } }).staffChat?.title ?? null : null;
    return {
      available: this.available,
      bot: this.available ? this.username : null,
      me: me ? { tgName: me.tgName, digest: me.digest, signals: me.signals, weekly: me.weekly, monthly: me.monthly, legacyWeekly: me.legacyWeekly, blocked: !!me.blockedAt, connectedAt: me.createdAt } : null,
      // the clinic's two digest schedules: the daily one, and the old rolling weekly one where it is still on
      digestFrequency,
      legacyWeeklyOn,
      digestTo: people.filter((p) => p.digest).map((p) => p.name),
      legacyWeeklyTo: people.filter((p) => p.legacyWeekly).map((p) => p.name),
      signalsTo: people.filter((p) => p.signals).map((p) => p.name),
      weeklyTo: people.filter((p) => p.weekly).map((p) => p.name),
      monthlyTo: people.filter((p) => p.monthly).map((p) => p.name),
      // still delivered through the clinic's patient bot until each person reconnects (shown as such in the workspace)
      legacy: { digest: legacy, group },
    };
  }

  async link(clinicId: string, userId: string) {
    if (!this.available) throw new BadRequestException('service_bot_off');
    const token = newToken();
    const expiresAt = new Date(Date.now() + LINK_TTL);
    await this.prisma.channelLink.create({ data: { clinicId, purpose: 'LEADER', createdById: userId, tokenHash: hashToken(token), expiresAt } });
    return { url: `https://t.me/${this.username}?start=l_${token}`, expiresAt };
  }

  // Only the signed-in person's own switches (never another manager's). Switching the weekly or monthly report on records the moment, so a report
  // that was due before it is never sent to this person.
  async update(clinicId: string, userId: string, d: { digest?: boolean; signals?: boolean; weekly?: boolean; monthly?: boolean; legacyWeekly?: boolean }) {
    const cur = await this.prisma.leaderTelegram.findUnique({ where: { clinicId_userId: { clinicId, userId } }, select: { weekly: true, monthly: true, digest: true } });
    if (!cur) throw new NotFoundException('leader_tg_not_connected');
    // the old rolling 7-day weekly digest: only ever switched off (no new subscription to it)
    if (d.legacyWeekly === true) throw new BadRequestException('legacy_weekly_closed');
    const now = new Date();
    await this.prisma.leaderTelegram.update({
      where: { clinicId_userId: { clinicId, userId } },
      data: {
        ...(d.digest !== undefined ? { digest: d.digest } : {}),
        ...(d.signals !== undefined ? { signals: d.signals } : {}),
        ...(d.weekly !== undefined ? { weekly: d.weekly, ...(d.weekly && !cur.weekly ? { weeklySince: now } : {}) } : {}),
        ...(d.monthly !== undefined ? { monthly: d.monthly, ...(d.monthly && !cur.monthly ? { monthlySince: now } : {}) } : {}),
        ...(d.legacyWeekly === false ? { legacyWeekly: false, legacyWeeklyMovedAt: now } : {}),
      },
    });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'leader_tg.settings', details: d } });
    return this.view(clinicId, userId);
  }

  async disconnect(clinicId: string, userId: string) {
    await this.prisma.leaderTelegram.deleteMany({ where: { clinicId, userId } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'leader_tg.disconnected', details: {} } });
    return this.view(clinicId, userId);
  }

  // ---------- recipients and delivery ----------

  // Who may receive now: a connection that is not blocked, of a person who is STILL the owner or a manager of this clinic (a removed member or a
  // lost role receives nothing, whatever the stored switches say)
  async recipients(clinicId: string, kind?: LeaderKind) {
    const rows = await this.prisma.leaderTelegram.findMany({
      where: { clinicId, blockedAt: null, ...(kind ? { [kind]: true } : {}), user: { memberships: { some: { clinicId, role: { in: LEADER_ROLES as never } } } } },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { name: true } } },
    });
    return rows.map((r) => ({ id: r.id, userId: r.userId, chatId: r.chatId, lang: r.lang as Lang, name: r.user.name, digest: r.digest, signals: r.signals, weekly: r.weekly, weeklySince: r.weeklySince, monthly: r.monthly, monthlySince: r.monthlySince, legacyWeekly: r.legacyWeekly }));
  }

  // Sends one text to every current recipient of this kind; returns how many Telegram confirmed. A blocked bot marks the connection.
  async send(clinicId: string, kind: LeaderKind, text: (lang: Lang) => string, only?: string[]): Promise<number> {
    if (!this.token) return 0;
    let ok = 0;
    for (const r of await this.recipients(clinicId, kind)) {
      if (only && !only.includes(r.chatId)) continue;
      try {
        await this.api.sendMessage(this.token, r.chatId, text(r.lang));
        ok++;
      } catch (e) {
        if (e instanceof TelegramError && e.code === 403) await this.prisma.leaderTelegram.update({ where: { id: r.id }, data: { blockedAt: new Date() } }).catch(() => undefined);
        this.log.warn(`Службовий бот: не доставлено (${(e as Error).message})`);
      }
    }
    return ok;
  }

  // One message to ONE connection, for a delivery that must know its exact outcome (a signal event, the current state sent to oneself): the
  // connection must still be a current recipient (not blocked, still the owner or a manager; with `kind`, that kind switched on).
  // sent; gone (no longer a recipient, or the bot was blocked: 403); rejected (another explicit refusal of Telegram, nothing delivered);
  // unknown (a network error or a server error: it may have arrived, so it is never repeated).
  async deliverTo(clinicId: string, leaderId: string, text: (lang: Lang) => string, kind?: LeaderKind): Promise<'sent' | 'gone' | 'rejected' | 'unknown'> {
    if (!this.token) return 'gone';
    const r = (await this.recipients(clinicId, kind)).find((x) => x.id === leaderId);
    if (!r) return 'gone';
    try {
      await this.api.sendMessage(this.token, r.chatId, text(r.lang));
      return 'sent';
    } catch (e) {
      const code = e instanceof TelegramError ? e.code : undefined;
      if (code === 403) {
        await this.prisma.leaderTelegram.update({ where: { id: r.id }, data: { blockedAt: new Date() } }).catch(() => undefined);
        return 'gone';
      }
      this.log.warn(`Службовий бот: не доставлено (${(e as Error).message})`);
      return code !== undefined && code >= 400 && code < 500 ? 'rejected' : 'unknown';
    }
  }

  // ---------- the bot ----------

  async handle(update: TgUpdate) {
    if (!this.token) return;
    const token = this.token;
    if (update.callback_query) {
      const q = update.callback_query;
      await this.api.answerCallbackQuery(token, q.id).catch(() => undefined);
      const m = /^lc:(\S+)$/.exec(q.data ?? '');
      const chat = q.message?.chat.id;
      // only the person in their own private chat (the chat id of a private chat is the person's id)
      if (!m || chat === undefined || chat !== q.from.id) return;
      const name = [q.from.first_name, q.from.last_name].filter(Boolean).join(' ') || (q.from.username ? `@${q.from.username}` : 'Telegram');
      const res = await this.confirm(m[1], String(chat), name, langOf(q.from.language_code));
      await this.api.sendMessage(token, chat, res).catch(() => undefined);
      return;
    }
    const msg = update.message;
    if (!msg) return;
    const lang = langOf(msg.from?.language_code);
    const say = (text: string, extra: Record<string, unknown> = {}) => this.api.sendMessage(token, msg.chat.id, text, extra).catch(() => undefined);
    const start = /^\/start(?:@\w+)?\s+l_(\S+)/.exec((msg.text ?? '').trim());
    if (!start) return void (await say(T[lang].hello));
    if (msg.chat.type && msg.chat.type !== 'private') return void (await say(T[lang].group));
    // opening the link only shows the question; nothing is linked until the button is pressed
    const link = await this.validLink(start[1]);
    if (!link) return void (await say(T[lang].bad));
    return void (await say(fill(T[lang].confirm, { c: link.clinic, u: link.user }), { reply_markup: { inline_keyboard: [[{ text: T[lang].yes, callback_data: `lc:${start[1]}` }]] } }));
  }

  private async validLink(token: string) {
    const l = await this.prisma.channelLink.findUnique({ where: { tokenHash: hashToken(token) }, include: { clinic: { select: { name: true } } } });
    if (!l || l.purpose !== 'LEADER' || l.usedAt || l.expiresAt < new Date() || !l.createdById) return null;
    const user = await this.prisma.user.findUnique({ where: { id: l.createdById }, select: { name: true, email: true } });
    if (!user) return null;
    return { id: l.id, clinicId: l.clinicId, userId: l.createdById, clinic: l.clinic.name, user: `${user.name} (${user.email})` };
  }

  // The button: the link is used once (claimed atomically, a repeated tap or a replayed update changes nothing), the person must still lead
  // the clinic, one Telegram per person per clinic and one person per Telegram per clinic
  async confirm(token: string, chatId: string, tgName: string, lang: Lang): Promise<string> {
    const t = T[lang];
    const link = await this.validLink(token);
    if (!link) return t.bad;
    const role = await this.prisma.membership.findUnique({ where: { userId_clinicId: { userId: link.userId, clinicId: link.clinicId } }, select: { role: true } });
    if (!role || !LEADER_ROLES.includes(role.role)) return t.noRole;
    const mine = await this.prisma.leaderTelegram.findUnique({ where: { clinicId_userId: { clinicId: link.clinicId, userId: link.userId } } });
    if (mine && mine.chatId !== chatId) return fill(t.other, { c: link.clinic });
    const holder = await this.prisma.leaderTelegram.findUnique({ where: { clinicId_chatId: { clinicId: link.clinicId, chatId } } });
    if (holder && holder.userId !== link.userId) return fill(t.taken, { c: link.clinic });
    const claimed = await this.prisma.channelLink.updateMany({ where: { id: link.id, usedAt: null }, data: { usedAt: new Date() } });
    if (!claimed.count) return t.bad;
    // the same person's legacy digest chat (the clinic's patient bot, the same private chat id): the digest they already had continues here,
    // and the old route stops, so it never arrives twice; nothing else is switched on
    // the format it got continues: the daily digest, or the old weekly one (carried over as such, never turned into the daily one)
    const legacy = await this.prisma.digestRecipient.findMany({ where: { clinicId: link.clinicId, chatId, migratedAt: null }, select: { id: true, legacyWeekly: true } });
    const carry = { ...(legacy.some((x) => !x.legacyWeekly) ? { digest: true } : {}), ...(legacy.some((x) => x.legacyWeekly) ? { legacyWeekly: true } : {}) };
    await this.prisma.leaderTelegram.upsert({
      where: { clinicId_userId: { clinicId: link.clinicId, userId: link.userId } },
      create: { clinicId: link.clinicId, userId: link.userId, chatId, tgName, lang, ...carry },
      update: { tgName, lang, blockedAt: null, ...carry },
    });
    if (legacy.length) await this.prisma.digestRecipient.updateMany({ where: { id: { in: legacy.map((x) => x.id) } }, data: { migratedAt: new Date() } });
    await this.prisma.auditLog.create({ data: { clinicId: link.clinicId, userId: link.userId, action: 'leader_tg.connected', details: { carriedDigest: legacy.length > 0 } } });
    return fill(t.done, { c: link.clinic });
  }
}
