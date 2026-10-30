import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { randomBytes, timingSafeEqual } from 'crypto';
import { clinicDate, clinicHm } from '../common/clinic-time';
import { decrypt, encrypt } from '../common/crypto';
import { normalizePhone } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken, newToken } from '../auth/tokens';
import { isRussian } from '../ai/guardrails';
import { AutoReplyService } from './auto-reply.service';
import { DigestService } from './digest.service';
import { InboundService } from './inbound.service';
import { WaitlistService } from './waitlist.service';
import { RequestsService } from './requests.service';
import { StaffNotifierService } from './staff-notifier.service';
import { TelegramApi, TelegramError, TgUpdate } from './telegram.api';

const LINK_TTL = 14 * 86_400_000;
const T = {
  linked: (clinic: string) => `Готово! Ви підключили нагадування від клініки «${clinic}». Щоб відмовитися, напишіть «Зупинити».`,
  askPhone: 'Вітаємо! Щоб підключити нагадування, поділіться номером телефону кнопкою нижче.',
  notFound: 'Не знайшли вас у базі за цим номером. Зверніться, будь ласка, до адміністратора клініки.',
  stopped: 'Гаразд, більше не надсилатимемо повідомлень. Щоб підключити знову, зверніться до адміністратора клініки.',
  received: 'Дякуємо, повідомлення отримано. Адміністратор клініки відповість найближчим часом.',
  other: 'Це автоматичний чат клініки. Для запису чи запитань зателефонуйте адміністратору.',
  badLink: 'Це посилання вже недійсне. Попросіть адміністратора клініки видати нове.',
};

@Injectable()
export class TelegramService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(TelegramService.name);
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    private prisma: PrismaService,
    private api: TelegramApi,
    private autoReply: AutoReplyService,
    private requests: RequestsService,
    private staff: StaffNotifierService,
    private digest: DigestService,
    private inbound: InboundService,
    private waitlist: WaitlistService,
  ) {
    this.inbound.register('TELEGRAM', async (clinicId, payload) => {
      const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.TELEGRAM } } });
      if (!i?.apiKeyEnc) return;
      await this.handleUpdate(clinicId, decrypt(i.apiKeyEnc), payload as TgUpdate);
    });
  }

  // В разработке сервер не доступен из интернета, поэтому бот опрашивается сам. В продакшене Telegram присылает обновления вебхуком.
  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'production' || process.env.TELEGRAM_POLL === 'false') return;
    this.timer = setInterval(() => void this.poll(), 3000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async status(clinicId: string) {
    const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.TELEGRAM } } });
    const cfg = (i?.config ?? {}) as { username?: string; staffChat?: { title: string } };
    const linked = await this.prisma.patientChannel.count({ where: { clinicId, channel: 'TELEGRAM', optedOutAt: null } });
    return { connected: !!i?.apiKeyEnc, username: cfg.username ?? null, linkedPatients: linked, staffChat: cfg.staffChat?.title ?? null };
  }

  // Сохраняет токен бота (после проверки у Telegram), в базе он лежит зашифрованным
  async connect(clinicId: string, token: string) {
    let me: { username: string };
    try {
      me = await this.api.getMe(token);
    } catch {
      throw new BadRequestException('bad_bot_token');
    }
    const secret = randomBytes(24).toString('base64url');
    const prev = (await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.TELEGRAM } } }))?.config as { staffChat?: unknown } | null;
    const config = { username: me.username, secret, offset: 0, ...(prev?.staffChat ? { staffChat: prev.staffChat } : {}) };
    await this.prisma.integration.upsert({
      where: { clinicId_provider: { clinicId, provider: Provider.TELEGRAM } },
      create: { clinicId, provider: Provider.TELEGRAM, apiKeyEnc: encrypt(token), config },
      update: { apiKeyEnc: encrypt(token), config },
    });
    try {
      if (process.env.NODE_ENV === 'production') {
        const origin = (process.env.WEB_ORIGIN ?? '').replace(/\/$/, '');
        await this.api.setWebhook(token, `${origin}/backend/telegram/webhook/${secret}`, secret);
      } else {
        await this.api.deleteWebhook(token); // без вебхука работает опрос
      }
    } catch (e) {
      this.log.warn(`Webhook: ${(e as Error).message}`);
    }
    return this.status(clinicId);
  }

  async disconnect(clinicId: string) {
    const i = await this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId, provider: Provider.TELEGRAM } } });
    if (!i) return { connected: false };
    if (i.apiKeyEnc) await this.api.deleteWebhook(decrypt(i.apiKeyEnc)).catch(() => undefined);
    await this.prisma.integration.delete({ where: { id: i.id } });
    return { connected: false };
  }

  // Одноразовая ссылка для конкретного пациента: чат привяжется именно к его карточке
  async patientLink(clinicId: string, patientId: string) {
    const st = await this.status(clinicId);
    if (!st.connected) throw new BadRequestException('bot_not_connected');
    const p = await this.prisma.patient.findFirst({ where: { id: patientId, clinicId, removedAt: null }, select: { id: true } });
    if (!p) throw new NotFoundException('patient_not_found');
    const token = newToken();
    const expiresAt = new Date(Date.now() + LINK_TTL);
    await this.prisma.channelLink.create({ data: { clinicId, patientId, tokenHash: hashToken(token), expiresAt } });
    return { url: `https://t.me/${st.username}?start=${token}`, expiresAt };
  }

  // Общая ссылка клиники: человек делится номером, и мы находим карточку по телефону
  async generalLink(clinicId: string) {
    const st = await this.status(clinicId);
    if (!st.connected) throw new BadRequestException('bot_not_connected');
    return { url: `https://t.me/${st.username}` };
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const rows = await this.prisma.integration.findMany({ where: { provider: Provider.TELEGRAM, apiKeyEnc: { not: null } } });
      for (const i of rows) {
        const token = decrypt(i.apiKeyEnc!);
        const cfg = i.config as { offset?: number };
        try {
          const updates = await this.api.getUpdates(token, (cfg.offset ?? 0) + 1 > 1 ? cfg.offset! + 1 : undefined);
          let last = cfg.offset ?? 0;
          for (const u of updates) {
            await this.inbound.receive(i.clinicId, 'TELEGRAM', `${i.clinicId}:${u.update_id}`, u);
            last = Math.max(last, u.update_id);
          }
          if (last !== (cfg.offset ?? 0)) {
            const fresh = await this.prisma.integration.findUnique({ where: { id: i.id } });
            if (fresh) await this.prisma.integration.update({ where: { id: i.id }, data: { config: { ...(fresh.config as object), offset: last } } });
          }
        } catch (e) {
          if (!(e instanceof TelegramError)) this.log.warn(`Опрос Telegram: ${(e as Error).message}`);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  async handleWebhook(secret: string, header: string | undefined, update: TgUpdate) {
    // The secret picks the clinic in the database (no scan of every bot); strangers and forged requests are ignored silently
    const i = secret ? await this.prisma.integration.findFirst({ where: { provider: Provider.TELEGRAM, config: { path: ['secret'], equals: secret } } }) : null;
    const a = Buffer.from(header ?? '');
    const b = Buffer.from(secret);
    if (!i?.apiKeyEnc || a.length !== b.length || !timingSafeEqual(a, b)) return;
    await this.inbound.receive(i.clinicId, 'TELEGRAM', `${i.clinicId}:${update.update_id}`, update);
  }

  // Разбор одного сообщения от пациента: подключение по ссылке, по номеру, отписка
  async handleUpdate(clinicId: string, token: string, update: TgUpdate) {
    if (update.callback_query) return this.handleCallback(clinicId, token, update.callback_query);
    const m = update.message;
    if (!m) return;
    const chatId = String(m.chat.id);
    const username = m.from?.username;
    const say = (text: string, extra: Record<string, unknown> = {}) => this.api.sendMessage(token, chatId, text, extra).catch(() => undefined);
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true, suspendedAt: true } });
    if (clinic.suspendedAt) return; // a suspended clinic does not process chats
    const text = (m.text ?? '').trim();

    // Привязка служебного чата: «/chat КОД» (в группе Telegram может добавить @имя_бота)
    const bindCmd = /^\/chat(?:@\w+)?\s+(\S+)/i.exec(text);
    if (bindCmd) {
      const title = m.chat.title ?? (m.from?.first_name ? `Чат з ${m.from.first_name}` : 'Службовий чат');
      const ok = await this.staff.bind(clinicId, bindCmd[1], { id: chatId, title });
      return void (await say(ok ? 'Службовий чат підключено: сюди надходитимуть нові заявки клініки.' : 'Код недійсний або застарів. Створіть новий у налаштуваннях сервісу.'));
    }
    // Сообщения из служебного чата не пациентские: ничего не сохраняем и не отвечаем
    if ((await this.staff.chat(clinicId))?.id === chatId) return;

    // Руководитель привязывает чат к дайджесту ссылкой «owner_…»; получатель дайджеста может запросить сводку командой /digest
    const ownerLink = /^\/start\s+owner_(\S+)/.exec(text);
    if (ownerLink) {
      const lang = m.from?.language_code?.startsWith('ru') ? 'ru' : m.from?.language_code?.startsWith('en') ? 'en' : 'uk';
      const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || (username ? `@${username}` : 'Керівник');
      const ok = await this.digest.bind(clinicId, ownerLink[1], { id: chatId, name, lang });
      return void (await say(ok ? 'Дайджест підключено. Команда /digest надішле свіже зведення.' : 'Це посилання недійсне або застаріло. Створіть нове в налаштуваннях сервісу.'));
    }
    if (await this.digest.isRecipient(clinicId, chatId)) {
      if (/^\/digest\b/i.test(text)) await this.digest.send(clinicId, 'WEEKLY', [chatId]);
      return;
    }

    if (/^\/?(stop|зупинити|остановить)$/i.test(text)) {
      await this.prisma.patientChannel.updateMany({ where: { clinicId, channel: 'TELEGRAM', externalId: chatId }, data: { optedOutAt: new Date() } });
      return void (await say(T.stopped));
    }

    if (text.startsWith('/start')) {
      const payload = text.slice(6).trim();
      if (!payload) return void (await say(T.askPhone, { reply_markup: { keyboard: [[{ text: 'Поділитися номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }));
      const link = await this.prisma.channelLink.findUnique({ where: { tokenHash: hashToken(payload) } });
      if (!link || link.clinicId !== clinicId || link.usedAt || link.expiresAt < new Date() || !link.patientId) return void (await say(T.badLink));
      await this.prisma.channelLink.update({ where: { id: link.id }, data: { usedAt: new Date() } });
      await this.bind(clinicId, link.patientId, chatId, username);
      return void (await say(T.linked(clinic.name), { reply_markup: { remove_keyboard: true } }));
    }

    if (m.contact) {
      // Принимаем только собственный контакт человека, чужой номер привязать нельзя
      if (m.contact.user_id !== undefined && m.contact.user_id !== m.from?.id) return void (await say(T.notFound));
      const phone = normalizePhone(m.contact.phone_number);
      const patients = phone ? await this.prisma.patient.findMany({ where: { clinicId, removedAt: null, phoneNorm: phone }, select: { id: true } }) : [];
      if (!patients.length) return void (await say(T.notFound, { reply_markup: { remove_keyboard: true } }));
      for (const p of patients) await this.bind(clinicId, p.id, chatId, username);
      return void (await say(T.linked(clinic.name), { reply_markup: { remove_keyboard: true } }));
    }

    if (!text) return void (await say(T.other)); // фото, стикеры и т. п. пока не принимаем
    // Обычное сообщение: сохраняем во входящие. Один вежливый ответ в сутки, чтобы человек знал, что его увидят.
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel: 'TELEGRAM', externalId: chatId }, select: { patientId: true } });
    const contactName = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || (username ? `@${username}` : null);
    await this.prisma.chatMessage.create({ data: { clinicId, patientId: ch?.patientId ?? null, channel: 'TELEGRAM', chatId, contactName, direction: 'IN', text: text.slice(0, 4000) } });
    // Комментарий к низкой оценке: сохраняем у отзыва, обновляем заявку администратору, ШІ не отвечает
    const pending = ch?.patientId ? await this.prisma.review.findFirst({ where: { clinicId, patientId: ch.patientId, comment: null, awaitingUntil: { gt: new Date() } }, orderBy: { updatedAt: 'desc' } }) : null;
    if (pending) {
      const comment = text.slice(0, 1000);
      await this.prisma.review.update({ where: { id: pending.id }, data: { comment, awaitingUntil: null } });
      await this.requests.upsert(clinicId, { channel: 'TELEGRAM', chatId, patientId: ch!.patientId, contactName, kind: 'REVIEW', summary: `Оцінка ${pending.rating} з 5${pending.doctorName ? `, лікар ${pending.doctorName}` : ''}. Коментар: «${comment.slice(0, 300)}»` }, true);
      const sending = (await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { sendingEnabled: true } })).sendingEnabled;
      if (sending) {
        const thanks = isRussian(text) ? 'Спасибо, передали руководителю. Мы свяжемся с вами.' : 'Дякуємо, передали керівнику. Ми зв’яжемося з вами.';
        await say(thanks);
        await this.prisma.chatMessage.create({ data: { clinicId, patientId: ch!.patientId, channel: 'TELEGRAM', chatId, direction: 'OUT', text: thanks } });
      }
      return;
    }
    // Автоответ ШІ (если клиника его включила); иначе обычный вежливый ответ раз в сутки
    if (await this.autoReply.onInbound(clinicId, 'TELEGRAM', chatId)) return;
    const recent = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel: 'TELEGRAM', chatId, direction: 'OUT', authorUserId: null, createdAt: { gt: new Date(Date.now() - 86_400_000) } }, select: { id: true } });
    if (!recent) {
      await say(T.received);
      await this.prisma.chatMessage.create({ data: { clinicId, patientId: ch?.patientId ?? null, channel: 'TELEGRAM', chatId, direction: 'OUT', text: T.received } });
    }
  }

  // Пациент нажал кнопку с вариантом времени: сохраняем выбор, создаём заявку администратору, благодарим
  private async handleCallback(clinicId: string, token: string, cq: NonNullable<TgUpdate['callback_query']>) {
    await this.api.answerCallbackQuery(token, cq.id).catch(() => undefined);
    const chatId = String(cq.message?.chat.id ?? cq.from.id);
    const confirm = /^confirm\|([A-Za-z0-9]{10,40})\|(y|m)$/.exec(cq.data ?? '');
    if (confirm) return this.handleConfirm(clinicId, token, chatId, confirm[1], confirm[2] === 'y');
    const wl = /^wl\|([A-Za-z0-9]{10,40})\|(y|n)$/.exec(cq.data ?? '');
    if (wl) return this.handleWaitlist(clinicId, token, chatId, wl[1], wl[2] === 'y');
    const rate = /^rate\|([A-Za-z0-9]{10,40})\|([1-5])$/.exec(cq.data ?? '');
    if (rate) return this.handleRating(clinicId, token, chatId, rate[1], Number(rate[2]));
    const m = /^slot\|(\d{4})-(\d{2})-(\d{2})\|(\d{2}:\d{2})(?:\|(.{1,24}))?$/u.exec(cq.data ?? '');
    if (!m) return;
    const known = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel: 'TELEGRAM', chatId }, select: { id: true } });
    if (!known) return;
    const label = `${m[3]}.${m[2]} ${m[4]}${m[5] ? `, лікар ${m[5]}` : ''}`;
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel: 'TELEGRAM', externalId: chatId }, select: { patientId: true, optedOutAt: true } });
    const named = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel: 'TELEGRAM', chatId, contactName: { not: null } }, orderBy: { createdAt: 'desc' }, select: { contactName: true } });
    const lastIn = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel: 'TELEGRAM', chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { text: true } });
    await this.prisma.chatMessage.create({ data: { clinicId, patientId: ch?.patientId ?? null, channel: 'TELEGRAM', chatId, contactName: named?.contactName ?? null, direction: 'IN', text: `Обрав час: ${label}` } });
    const open = await this.requests.openFor(clinicId, 'TELEGRAM', chatId);
    await this.requests.upsert(clinicId, { channel: 'TELEGRAM', chatId, patientId: ch?.patientId ?? null, contactName: named?.contactName ?? null, kind: (open?.kind as 'BOOKING' | 'RESCHEDULE' | 'CANCEL') ?? 'BOOKING', summary: `Обрано час: ${label}. ${open?.summary ?? ''}`.trim() }, true);
    // Благодарность — ответ на действие пациента; уходит, только если отправка в клинике включена
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { sendingEnabled: true } });
    if (!clinic.sendingEnabled || ch?.optedOutAt) return;
    const text = isRussian(lastIn?.text ?? '') ? `Спасибо! Передали ваш выбор администратору: ${label}. Он подтвердит запись.` : `Дякуємо! Передали ваш вибір адміністратору: ${label}. Він підтвердить запис.`;
    await this.api.sendMessage(token, chatId, text).catch(() => undefined);
    await this.prisma.chatMessage.create({ data: { clinicId, patientId: ch?.patientId ?? null, channel: 'TELEGRAM', chatId, direction: 'OUT', text, byAi: true } });
  }

  // The patient answered an offer from the waiting list
  private async handleWaitlist(clinicId: string, token: string, chatId: string, offerId: string, yes: boolean) {
    const r = await this.waitlist.respond(clinicId, chatId, offerId, yes);
    if (!r || r.text === 'ignored') return;
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { sendingEnabled: true } });
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel: 'TELEGRAM', externalId: chatId }, select: { patientId: true, optedOutAt: true } });
    if (!clinic.sendingEnabled || ch?.optedOutAt) return;
    const text =
      r.text === 'accepted' ? `Дякуємо! Час ${r.label} утримуємо за вами, адміністратор підтвердить запис.`
      : r.text === 'declined' ? 'Гаразд, час запропонуємо комусь іншому. Ви залишаєтеся в списку очікування.'
      : `На жаль, час ${r.label} уже недоступний. Ви залишаєтеся в списку очікування: запропонуємо інший.`;
    await this.api.sendMessage(token, chatId, text).catch(() => undefined);
    await this.prisma.chatMessage.create({ data: { clinicId, patientId: ch?.patientId ?? null, channel: 'TELEGRAM', chatId, direction: 'OUT', text } });
  }

  // The patient answered a reminder: "I confirm" is remembered on the visit (only here, Cliniccards is not changed);
  // "I want to reschedule" becomes a request for the administrator
  private async handleConfirm(clinicId: string, token: string, chatId: string, visitId: string, yes: boolean) {
    const visit = await this.prisma.visit.findFirst({ where: { id: visitId, clinicId, status: { in: ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED'] }, startsAt: { gt: new Date() } }, select: { id: true, patientId: true, startsAt: true } });
    if (!visit) return;
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel: 'TELEGRAM', externalId: chatId, patientId: visit.patientId }, select: { optedOutAt: true } });
    if (!ch) return;
    const when = `${clinicDate(visit.startsAt).slice(5).split('-').reverse().join('.')} ${clinicHm(visit.startsAt)}`;
    if (yes) await this.prisma.visit.update({ where: { id: visit.id }, data: { patientConfirmedAt: new Date() } });
    else await this.requests.upsert(clinicId, { channel: 'TELEGRAM', chatId, patientId: visit.patientId, kind: 'RESCHEDULE', summary: `Пацієнт просить перенести запис ${when} (відповідь на нагадування).` });
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { sendingEnabled: true } });
    if (!clinic.sendingEnabled || ch.optedOutAt) return;
    const lastIn = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel: 'TELEGRAM', chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { text: true } });
    const ru = isRussian(lastIn?.text ?? '');
    const text = yes
      ? ru ? `Спасибо, ждём вас ${when}.` : `Дякуємо, чекаємо на вас ${when}.`
      : ru ? 'Передали администратору: он свяжется с вами, чтобы подобрать другое время.' : 'Передали адміністратору: він зв’яжеться з вами, щоб підібрати інший час.';
    await this.api.sendMessage(token, chatId, text).catch(() => undefined);
    await this.prisma.chatMessage.create({ data: { clinicId, patientId: visit.patientId, channel: 'TELEGRAM', chatId, direction: 'OUT', text } });
  }

  // Пациент нажал оценку 1-5. Оценка сохраняется всегда; низкая сразу становится заявкой администратору и ждёт комментарий.
  private async handleRating(clinicId: string, token: string, chatId: string, visitId: string, rating: number) {
    const visit = await this.prisma.visit.findFirst({ where: { id: visitId, clinicId }, select: { id: true, patientId: true, doctorName: true } });
    if (!visit) return;
    // оценить визит может только пациент, чей это чат
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel: 'TELEGRAM', externalId: chatId, patientId: visit.patientId }, select: { optedOutAt: true } });
    if (!ch) return;
    const awaiting = rating <= 3 ? new Date(Date.now() + 86_400_000) : null;
    await this.prisma.review.upsert({
      where: { visitId: visit.id },
      create: { clinicId, patientId: visit.patientId, visitId: visit.id, rating, doctorName: visit.doctorName, awaitingUntil: awaiting },
      update: { rating, awaitingUntil: awaiting },
    });
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { sendingEnabled: true, reviewUrl: true } });
    if (rating <= 3) {
      await this.requests.upsert(clinicId, { channel: 'TELEGRAM', chatId, patientId: visit.patientId, kind: 'REVIEW', summary: `Оцінка ${rating} з 5${visit.doctorName ? `, лікар ${visit.doctorName}` : ''}. Коментаря поки немає.` });
    }
    if (!clinic.sendingEnabled || ch.optedOutAt) return;
    const lastIn = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel: 'TELEGRAM', chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { text: true } });
    const ru = isRussian(lastIn?.text ?? '');
    // The same neutral invitation to leave a public review goes to everyone, whatever the rating: choosing only the satisfied
    // patients breaks the rules of review platforms. A low rating additionally starts the private complaint flow.
    const invite = clinic.reviewUrl ? `${ru ? 'Если есть минутка, оставьте отзыв:' : 'Якщо маєте хвилинку, залиште відгук:'} ${clinic.reviewUrl}` : '';
    const text =
      rating >= 4
        ? `${ru ? 'Спасибо за высокую оценку!' : 'Дякуємо за високу оцінку!'}${invite ? ` ${invite}` : ''}`
        : `${
            ru
              ? 'Спасибо за честную оценку и простите, что не всё сложилось. Расскажите одним сообщением, что именно пошло не так: мы разберёмся.'
              : 'Дякуємо за чесну оцінку й вибачте, що не все склалося. Розкажіть одним повідомленням, що саме пішло не так: ми розберемося.'
          }${invite ? `\n\n${invite}` : ''}`;
    await this.api.sendMessage(token, chatId, text).catch(() => undefined);
    await this.prisma.chatMessage.create({ data: { clinicId, patientId: visit.patientId, channel: 'TELEGRAM', chatId, direction: 'OUT', text } });
  }

  private async bind(clinicId: string, patientId: string, chatId: string, username?: string) {
    await this.prisma.patientChannel.upsert({
      where: { patientId_channel: { patientId, channel: 'TELEGRAM' } },
      create: { clinicId, patientId, channel: 'TELEGRAM', externalId: chatId, username },
      update: { externalId: chatId, username, optedOutAt: null, linkedAt: new Date() },
    });
  }
}
