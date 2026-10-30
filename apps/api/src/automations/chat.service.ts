import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MessengerService, SendError } from './messenger.service';

const CHANNELS = ['TELEGRAM', 'INSTAGRAM', 'MESSENGER', 'WHATSAPP', 'VIBER', 'WEB'];

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private messenger: MessengerService,
  ) {}

  // Список диалогов: по последнему сообщению каждого чата, сверху новые; непрочитанные считаются отдельно
  async conversations(clinicId: string) {
    const [last, unread, names] = await Promise.all([
      this.prisma.chatMessage.findMany({
        where: { clinicId },
        distinct: ['channel', 'chatId'],
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { patient: { select: { id: true, fullName: true } } },
      }),
      this.prisma.chatMessage.groupBy({ by: ['channel', 'chatId'], where: { clinicId, direction: 'IN', readAt: null }, _count: true }),
      // имя известно только из входящих сообщений, а последним в диалоге может быть ответ
      this.prisma.chatMessage.findMany({ where: { clinicId, contactName: { not: null } }, distinct: ['channel', 'chatId'], orderBy: { createdAt: 'desc' }, select: { channel: true, chatId: true, contactName: true } }),
    ]);
    const nameMap = new Map(names.map((n) => [`${n.channel}:${n.chatId}`, n.contactName]));
    const unreadMap = new Map(unread.map((u) => [`${u.channel}:${u.chatId}`, u._count]));
    return last.map((m) => ({
      channel: m.channel,
      chatId: m.chatId,
      patient: m.patient,
      contactName: nameMap.get(`${m.channel}:${m.chatId}`) ?? null,
      lastText: m.text.slice(0, 120),
      lastDirection: m.direction,
      lastAt: m.createdAt,
      unread: unreadMap.get(`${m.channel}:${m.chatId}`) ?? 0,
    }));
  }

  // Открыть диалог: последние сообщения, входящие помечаются прочитанными
  async thread(clinicId: string, channel: string, chatId: string) {
    const messages = await this.prisma.chatMessage.findMany({ where: { clinicId, channel, chatId }, orderBy: { createdAt: 'desc' }, take: 200, include: { patient: { select: { id: true, fullName: true } } } });
    if (!messages.length) throw new NotFoundException('conversation_not_found');
    await this.prisma.chatMessage.updateMany({ where: { clinicId, channel, chatId, direction: 'IN', readAt: null }, data: { readAt: new Date() } });
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { optedOutAt: true } });
    const named = messages.find((m) => m.patient);
    return {
      channel,
      chatId,
      replyWindowOpen: await this.messenger.windowOpen(clinicId, channel, chatId),
      patient: named?.patient ?? null,
      contactName: messages.find((m) => m.contactName)?.contactName ?? null,
      optedOut: !!ch?.optedOutAt,
      messages: messages
        .reverse()
        .map((m) => ({ id: m.id, direction: m.direction, text: m.text, createdAt: m.createdAt, error: m.error, system: m.direction === 'OUT' && !m.authorUserId && !m.byAi, byAi: m.byAi })),
    };
  }

  // Ответ сотрудника. Уходит только при включённом главном выключателе и только в чат, который не отписался.
  async reply(clinicId: string, userId: string, channel: string, chatId: string, text: string) {
    if (!CHANNELS.includes(channel)) throw new BadRequestException('bad_channel');
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { sendingEnabled: true } });
    if (!clinic.sendingEnabled) throw new BadRequestException('sending_disabled');
    const known = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId }, select: { id: true } });
    if (!known) throw new NotFoundException('conversation_not_found');
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { optedOutAt: true, patientId: true } });
    if (ch?.optedOutAt) throw new BadRequestException('opted_out');
    const base = { clinicId, channel, chatId, direction: 'OUT', text, authorUserId: userId, patientId: ch?.patientId ?? null };
    try {
      await this.messenger.send(clinicId, channel, chatId, text);
    } catch (e) {
      if (e instanceof SendError && e.reason === 'not_connected') throw new BadRequestException(channel === 'TELEGRAM' ? 'bot_not_connected' : channel === 'INSTAGRAM' ? 'instagram_not_connected' : 'channel_not_connected');
      if (e instanceof SendError && e.reason === 'window_closed') throw new BadRequestException('window_closed');
      if (e instanceof SendError && e.blocked) await this.prisma.patientChannel.updateMany({ where: { clinicId, channel, externalId: chatId }, data: { optedOutAt: new Date() } });
      await this.prisma.chatMessage.create({ data: { ...base, error: e instanceof SendError ? e.message.slice(0, 200) : 'Не вдалося надіслати' } });
      throw new BadRequestException('send_failed');
    }
    await this.prisma.chatMessage.create({ data: base });
    return { ok: true };
  }

  // Привязать неизвестный чат к карточке пациента вручную (когда номер не совпал)
  async link(clinicId: string, channel: string, chatId: string, patientId: string) {
    const [patient, known] = await Promise.all([
      this.prisma.patient.findFirst({ where: { id: patientId, clinicId, removedAt: null }, select: { id: true } }),
      this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId }, select: { contactName: true } }),
    ]);
    if (!patient || !known) throw new NotFoundException('not_found');
    await this.prisma.patientChannel.upsert({
      where: { patientId_channel: { patientId, channel } },
      create: { clinicId, patientId, channel, externalId: chatId },
      update: { externalId: chatId, optedOutAt: null, linkedAt: new Date() },
    });
    await this.prisma.chatMessage.updateMany({ where: { clinicId, channel, chatId }, data: { patientId } });
    return { ok: true };
  }
}
