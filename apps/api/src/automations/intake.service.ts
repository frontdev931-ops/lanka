import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isRussian } from '../ai/guardrails';
import { normalizePhone } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import { AutoReplyService } from './auto-reply.service';
import { MessengerService } from './messenger.service';
import { RequestsService } from './requests.service';

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
  constructor(
    private prisma: PrismaService,
    private messenger: MessengerService,
    private autoReply: AutoReplyService,
    private requests: RequestsService,
  ) {}

  async handle(clinicId: string, m: IncomingMessage): Promise<void> {
    const { channel, chatId } = m;
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { suspendedAt: true, sendingEnabled: true } });
    if (clinic.suspendedAt) return;
    const text = m.text.trim();
    const slot = m.payload ? SLOT.exec(m.payload) : null;
    if (!text && !slot) return; // photos, stickers and the like are not handled yet

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
    const stored = label ? `Обрав час: ${label}` : text.slice(0, 4000);
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

    if (label) {
      // The person chose a time on a button: a request for the administrator
      const open = await this.requests.openFor(clinicId, channel, chatId);
      await this.requests.upsert(clinicId, { channel, chatId, patientId: ch?.patientId ?? null, contactName, kind: (open?.kind as 'BOOKING' | 'RESCHEDULE' | 'CANCEL') ?? 'BOOKING', summary: `Обрано час: ${label}. ${open?.summary ?? ''}`.trim() }, true);
      if (clinic.sendingEnabled) {
        const lastText = (await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'IN', NOT: { text: stored } }, orderBy: { createdAt: 'desc' }, select: { text: true } }))?.text ?? '';
        await this.reply(clinicId, channel, ch?.patientId ?? null, chatId, isRussian(lastText) ? `Спасибо! Передали ваш выбор администратору: ${label}. Он подтвердит запись.` : `Дякуємо! Передали ваш вибір адміністратору: ${label}. Він підтвердить запис.`, true);
      }
      return;
    }

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
