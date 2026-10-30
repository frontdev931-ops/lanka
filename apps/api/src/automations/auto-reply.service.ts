import { Injectable, Logger } from '@nestjs/common';
import { hasFeature } from '../service/plans';
import { ChatAssistantService } from '../ai/chat-assistant.service';
import { PrismaService } from '../prisma/prisma.service';
import { RequestKind, RequestsService } from './requests.service';
import { MessengerService, SendError } from './messenger.service';

const MAX_AI_REPLIES_PER_DAY = 6;
const STAFF_TAKEOVER_MS = 30 * 60_000;

// Автоответ ШІ на входящее сообщение пациента. Работает только если клиника включила ШІ, автоответ и общую отправку.
// Любой сбой или отказ (лимит, опасная тема, ошибка модели) возвращает false: тогда действует обычный путь с одним
// вежливым ответом в сутки, а сообщение ждёт сотрудника в «Листування».
@Injectable()
export class AutoReplyService {
  private readonly log = new Logger(AutoReplyService.name);

  constructor(
    private prisma: PrismaService,
    private assistant: ChatAssistantService,
    private messenger: MessengerService,
    private requests: RequestsService,
  ) {}

  private async handOffNoAllowance(clinicId: string, channel: string, chatId: string) {
    const lastIn = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { text: true, patientId: true, contactName: true } });
    await this.requests.upsert(clinicId, { channel, chatId, patientId: lastIn?.patientId ?? null, contactName: lastIn?.contactName ?? null, kind: 'HANDOFF', summary: `Ліміт відповідей ШІ вичерпано, відповідь потрібна людині: «${(lastIn?.text ?? '').slice(0, 200)}»` });
  }

  async onInbound(clinicId: string, channel: string, chatId: string): Promise<boolean> {
    try {
      const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiEnabled: true, aiAutoReply: true, sendingEnabled: true, suspendedAt: true, plan: true } });
      if (clinic.suspendedAt || !clinic.aiEnabled || !clinic.aiAutoReply || !clinic.sendingEnabled || !hasFeature(clinic.plan, 'ai_autoreply')) return false;
      const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { optedOutAt: true, patientId: true } });
      if (ch?.optedOutAt) return false;
      // Сотрудник уже подхватил диалог: ШІ не вмешивается
      const staff = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'OUT', authorUserId: { not: null }, createdAt: { gt: new Date(Date.now() - STAFF_TAKEOVER_MS) } }, select: { id: true } });
      if (staff) return false;
      const today = await this.prisma.chatMessage.count({ where: { clinicId, channel, chatId, byAi: true, createdAt: { gt: new Date(Date.now() - 86_400_000) } } });
      if (today >= MAX_AI_REPLIES_PER_DAY) return false;

      const d = await this.assistant.draft(clinicId, channel, chatId);
      try {
        await this.messenger.send(clinicId, channel, chatId, d.reply, d.options);
      } catch (e) {
        if (e instanceof SendError && e.blocked && channel === 'TELEGRAM') await this.prisma.patientChannel.updateMany({ where: { clinicId, channel, externalId: chatId }, data: { optedOutAt: new Date() } });
        return false;
      }
      await this.prisma.chatMessage.create({ data: { clinicId, patientId: ch?.patientId ?? null, channel, chatId, direction: 'OUT', text: d.reply, byAi: true, ...(d.options.length ? { buttons: d.options.map((o) => ({ label: o.label, payload: `slot|${o.date}|${o.time}${o.doctor ? `|${o.doctor.slice(0, 16)}` : ''}` })) } : {}) } });
      // Заявка администратору: запись, перенос, отмена или вопрос, переданный человеку
      const kind: RequestKind | null = d.handoff ? 'HANDOFF' : ({ booking: 'BOOKING', reschedule: 'RESCHEDULE', cancel: 'CANCEL' } as Record<string, RequestKind>)[d.intent] ?? null;
      if (kind) {
        const lastIn = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { text: true, contactName: true } });
        const named = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, contactName: { not: null } }, orderBy: { createdAt: 'desc' }, select: { contactName: true } });
        await this.requests.upsert(clinicId, { channel, chatId, patientId: ch?.patientId ?? null, contactName: named?.contactName ?? null, kind, summary: kind === 'HANDOFF' ? `Питання передано людині: «${(lastIn?.text ?? '').slice(0, 200)}»` : (d.summary ?? (lastIn?.text ?? '').slice(0, 200)) });
      }
      return true;
    } catch (e) {
      // The reply allowance is used up: the conversation goes to a person, who sees a request (no debt, nothing is lost)
      if ((e as Error).message === 'ai_limit') await this.handOffNoAllowance(clinicId, channel, chatId).catch(() => undefined);
      else this.log.warn(`Автоответ не отправлен: ${(e as Error).message}`);
      return false;
    }
  }
}
