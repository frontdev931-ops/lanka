import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normalizePhone } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import { AutoReplyService } from './auto-reply.service';
import { BookingFlowService } from './booking-flow.service';
import { MessengerService } from './messenger.service';
import { RequestsService } from './requests.service';
import { parseTypedTime } from './typed-time';

const STOP = /^\/?(stop|зупинити|остановить)$/i;
export const SLOT = /^slot\|(\d{4})-(\d{2})-(\d{2})\|(\d{2}:\d{2})(?:\|(.{1,24}))?$/u;
const RECEIVED = 'Дякуємо, повідомлення отримано. Адміністратор клініки відповість найближчим часом.';
const STOPPED = 'Гаразд, більше не писатимемо першими. Якщо знадобиться запис, просто напишіть нам.';

// One incoming message from a person in a chat, the same shape for every channel except Telegram (which has its own flows)
export interface IncomingMessage {
  channel: string;
  chatId: string;
  // Id of the message in the channel: a repeated delivery is saved once
  mid: string | null;
  text: string;
  // A tapped button (appointment time): slot|date|time[|doctor]
  payload?: string;
  // The name the channel gave us, or a function to ask for it (only called when the chat has no name yet)
  name?: string | null;
  profileName?: () => Promise<string | null>;
  // A phone number the CHANNEL itself vouches for (WhatsApp): a card with exactly this number is linked automatically
  verifiedPhone?: string;
}

// What happens to a person's message after the channel has delivered it: save, honour "stop", turn a tapped time into a request
// for the administrator, let the AI answer (if the clinic allows), otherwise one polite reply a day.
@Injectable()
export class IntakeService {
  private readonly log = new Logger(IntakeService.name);

  constructor(
    private prisma: PrismaService,
    private messenger: MessengerService,
    private autoReply: AutoReplyService,
    private requests: RequestsService,
    private flow: BookingFlowService,
  ) {}

  async handle(clinicId: string, m: IncomingMessage): Promise<void> {
    const { channel, chatId } = m;
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { suspendedAt: true, sendingEnabled: true } });
    if (clinic.suspendedAt) return;
    const text = m.text.trim();
    let payload = m.payload;
    // A tap that arrived as plain text (the channel did not pass the button's payload): when the text is exactly the title of a button
    // in the last message we sent, it is that button
    if (!payload && text) {
      const lastOut = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'OUT' }, orderBy: { createdAt: 'desc' }, select: { buttons: true } });
      const buttons = Array.isArray(lastOut?.buttons) ? (lastOut!.buttons as { label?: unknown; payload?: unknown }[]) : [];
      const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, ' ');
      const valid = buttons.filter((b): b is { label: string; payload: string } => typeof b.label === 'string' && typeof b.payload === 'string');
      let hit = valid.find((b) => norm(b.label) === norm(text));
      // A short typed time ("19:00", "на 11", "давай на 11") that fits exactly one offered button; a question is not a choice
      if (!hit) {
        const time = parseTypedTime(text);
        if (time) {
          const d = /(?<!\d)(\d{1,2})[.\-](\d{2})(?!\d)/.exec(text);
          const fits = valid.filter((b) => b.payload.split('|')[2] === time && (!d || time === `${d[1].padStart(2, '0')}:${d[2]}` || b.label.includes(`${d[1].padStart(2, '0')}.${d[2]}`)));
          if (new Set(fits.map((b) => b.payload)).size === 1) hit = fits[0];
        }
      }
      if (hit) {
        payload = hit.payload as string;
        this.log.log(`A button tap arrived as text and was matched to the button (clinic ${clinicId}, ${channel})`);
      }
    }
    const slot = payload ? SLOT.exec(payload) : null;
    // "yes, confirm" / "no, another time" under the question of the automatic booking
    const answer = payload ? /^book(yes|no)\|([A-Za-z0-9]{10,40})$/.exec(payload) : null;
    // the doctor: one of several named, or the answer to a proposed doctor
    const doc = payload ? /^doc(pick|yes|no|any|wish)\|([A-Za-z0-9]{1,40})$/.exec(payload) : null;
    if (!text && !slot && !answer && !doc) return; // photos, stickers and the like are not handled yet

    let ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { patientId: true, optedOutAt: true } });
    if (!ch && m.verifiedPhone) {
      const norm = normalizePhone(m.verifiedPhone);
      const cards = norm ? await this.prisma.patient.findMany({ where: { clinicId, removedAt: null, phoneNorm: norm }, select: { id: true } }) : [];
      // Exactly one card: the channel proved the number. Several cards with one number: a person decides.
      if (cards.length === 1) {
        await this.prisma.patientChannel.upsert({ where: { patientId_channel: { patientId: cards[0].id, channel } }, create: { clinicId, patientId: cards[0].id, channel, externalId: chatId }, update: { externalId: chatId, linkedAt: new Date() } });
        ch = { patientId: cards[0].id, optedOutAt: null };
      }
    }
    let contactName = (await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, contactName: { not: null } }, select: { contactName: true } }))?.contactName ?? m.name ?? null;
    if (!contactName && m.profileName) contactName = await m.profileName().catch(() => null);

    const label = slot ? `${slot[3]}.${slot[2]} ${slot[4]}${slot[5] ? `, лікар ${slot[5]}` : ''}` : null;
    const stored = label ? `Обрав час: ${label}` : doc ? text.slice(0, 200) || (doc[1] === 'yes' ? 'Так' : doc[1] === 'no' ? 'Ні' : 'Обрав лікаря') : answer ? text.slice(0, 200) || (answer[1] === 'yes' ? 'Так, підтверджую' : 'Ні, інший час') : text.slice(0, 4000);
    try {
      await this.prisma.chatMessage.create({ data: { clinicId, patientId: ch?.patientId ?? null, channel, chatId, contactName, direction: 'IN', text: stored, externalId: m.mid } });
    } catch (e) {
      // On a retry the message may be saved already (a repeated delivery never gets here: the durable inbox ignores it)
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }

    if (STOP.test(text)) {
      await this.prisma.patientChannel.updateMany({ where: { clinicId, channel, externalId: chatId }, data: { optedOutAt: new Date() } });
      if (clinic.sendingEnabled) await this.reply(clinicId, channel, ch?.patientId ?? null, chatId, STOPPED);
      return;
    }
    // The person asked us to stop (a card holds the mark; for a stranger the earlier "stop" message is the mark):
    // messages are kept for staff, nothing is answered automatically
    if (ch?.optedOutAt) return;
    if (!ch && (await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'IN', OR: ['stop', '/stop', 'зупинити', 'остановить'].map((t) => ({ text: { equals: t, mode: 'insensitive' as const } })) }, select: { id: true } }))) return;

    if (doc) {
      await this.flow.onDoctorAnswer({ clinicId, channel, chatId, patientId: ch?.patientId ?? null, contactName }, doc[1] as 'pick' | 'yes' | 'no' | 'any' | 'wish', doc[2]);
      return;
    }

    if (answer) {
      await this.flow.onConfirmAnswer({ clinicId, channel, chatId, patientId: ch?.patientId ?? null, contactName }, answer[1] === 'yes', answer[2]);
      return;
    }

    if (slot) {
      // The person chose a time on a button: the booking flow keeps the choice, asks for the name and the phone, then hands the request over
      await this.flow.onSlotChosen({ clinicId, channel, chatId, patientId: ch?.patientId ?? null, contactName }, { date: `${slot[1]}-${slot[2]}-${slot[3]}`, time: slot[4], doctor: slot[5] ?? null }, label!);
      return;
    }

    // An answer to the bot's question about the name and the phone is not for the AI
    if (await this.flow.onText({ clinicId, channel, chatId, patientId: ch?.patientId ?? null, contactName }, text)) return;
    if (await this.autoReply.onInbound(clinicId, channel, chatId)) return;
    // No AI answer: one polite reply per day, only when sending is on
    if (!clinic.sendingEnabled) return;
    const recent = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'OUT', authorUserId: null, createdAt: { gt: new Date(Date.now() - 86_400_000) } }, select: { id: true } });
    if (!recent) await this.reply(clinicId, channel, ch?.patientId ?? null, chatId, RECEIVED);
  }

  private async reply(clinicId: string, channel: string, patientId: string | null, chatId: string, text: string, byAi = false) {
    try {
      await this.messenger.send(clinicId, channel, chatId, text);
    } catch {
      return;
    }
    await this.prisma.chatMessage.create({ data: { clinicId, patientId, channel, chatId, direction: 'OUT', text, byAi } });
  }
}
