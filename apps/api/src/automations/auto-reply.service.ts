import { Injectable, Logger } from '@nestjs/common';
import { hasFeature } from '../service/plans';
import { ChatAssistantService } from '../ai/chat-assistant.service';
import { PrismaService } from '../prisma/prisma.service';
import { slotPayload } from './channels';
import { RequestKind, RequestsService } from './requests.service';
import { MessengerService, SendError } from './messenger.service';


// The AI's automatic reply to a patient's incoming message. Works only if the clinic turned on the AI, the automatic reply and sending in general.
// Any failure or refusal (limit, dangerous topic, model error) returns false: the ordinary path then applies, with one
// polite reply per day, and the message waits for the staff in "Listuvannia" (Messages).
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

  // Why the AI did not answer: only a code, the clinic and the channel (no chat id, no text, no tokens)
  private skip(clinicId: string, channel: string, reason: string): false {
    this.log.log(`AI autoreply skipped: ${reason} (clinic ${clinicId}, ${channel})`);
    return false;
  }

  // The AI is silent for a while after a PERSON answered in the chat. Messages of the system (a booking confirmation, a scripted question)
  // are not a person, and neither is a reply of staff that never left (a failed send). The end of the pause is when the last person's message is older than the pause, or when staff gave the dialog back.
  async pausedUntil(clinicId: string, channel: string, chatId: string): Promise<Date | null> {
    const resumed = await this.prisma.chatBotResume.findUnique({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } }, select: { resumedAt: true } });
    const minutes = (await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { aiPauseMinutes: true } }))?.aiPauseMinutes ?? 30;
    if (minutes <= 0) return null;
    const pauseMs = minutes * 60_000;
    const since = new Date(Math.max(Date.now() - pauseMs, resumed?.resumedAt.getTime() ?? 0));
    const staff = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'OUT', authorUserId: { not: null }, error: null, createdAt: { gt: since } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    return staff ? new Date(staff.createdAt.getTime() + pauseMs) : null;
  }

  async resume(clinicId: string, channel: string, chatId: string) {
    await this.prisma.chatBotResume.upsert({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } }, create: { clinicId, channel, chatId }, update: { resumedAt: new Date() } });
    return { ok: true };
  }

  async onInbound(clinicId: string, channel: string, chatId: string): Promise<boolean> {
    try {
      const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiEnabled: true, aiAutoReply: true, aiRepliesPerChatDay: true, sendingEnabled: true, suspendedAt: true, plan: true } });
      if (clinic.suspendedAt) return this.skip(clinicId, channel, 'clinic_suspended');
      if (!clinic.aiEnabled) return this.skip(clinicId, channel, 'ai_off');
      if (!clinic.aiAutoReply) return this.skip(clinicId, channel, 'autoreply_off');
      if (!clinic.sendingEnabled) return this.skip(clinicId, channel, 'sending_off');
      if (!hasFeature(clinic.plan, 'ai_autoreply')) return this.skip(clinicId, channel, 'plan_without_autoreply');
      const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { optedOutAt: true, patientId: true } });
      if (ch?.optedOutAt) return this.skip(clinicId, channel, 'opted_out');
      // A staff member has already taken the dialogue: the AI does not interfere
      if (await this.pausedUntil(clinicId, channel, chatId)) return this.skip(clinicId, channel, 'paused_after_staff_reply');
      const today = await this.prisma.chatMessage.count({ where: { clinicId, channel, chatId, byAi: true, createdAt: { gt: new Date(Date.now() - 86_400_000) } } });
      if (today >= clinic.aiRepliesPerChatDay) return this.skip(clinicId, channel, 'daily_ai_reply_cap');

      const d = await this.assistant.draft(clinicId, channel, chatId);
      // Why a question went to a person (a code only): medical, price, complaint, long, reply_check, model
      if (d.handoff) this.log.log(`AI autoreply handed over to a person: ${d.reason ?? 'unknown'} (clinic ${clinicId}, ${channel})`);
      try {
        await this.messenger.send(clinicId, channel, chatId, d.reply, d.options);
      } catch (e) {
        if (e instanceof SendError && e.blocked && channel === 'TELEGRAM') await this.prisma.patientChannel.updateMany({ where: { clinicId, channel, externalId: chatId }, data: { optedOutAt: new Date() } });
        return this.skip(clinicId, channel, `send_failed_${e instanceof SendError ? e.reason : 'error'}`);
      }
      await this.prisma.chatMessage.create({ data: { clinicId, patientId: ch?.patientId ?? null, channel, chatId, direction: 'OUT', text: d.reply, byAi: true, ...(d.options.length ? { buttons: d.options.map((o) => ({ label: o.label, payload: slotPayload(o) })) } : {}) } });
      // A request to the administrator: a booking, a reschedule, a cancellation or a question handed to a person
      const kind: RequestKind | null = d.handoff ? 'HANDOFF' : ({ booking: 'BOOKING', reschedule: 'RESCHEDULE', cancel: 'CANCEL' } as Record<string, RequestKind>)[d.intent] ?? null;
      if (kind) {
        const lastIn = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { text: true, contactName: true } });
        const named = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, contactName: { not: null } }, orderBy: { createdAt: 'desc' }, select: { contactName: true } });
        await this.requests.upsert(clinicId, { channel, chatId, patientId: ch?.patientId ?? null, contactName: named?.contactName ?? null, kind, summary: kind === 'HANDOFF' && !d.summary ? `Питання передано людині: «${(lastIn?.text ?? '').slice(0, 200)}»` : (d.summary ?? (lastIn?.text ?? '').slice(0, 200)), service: kind === 'BOOKING' ? d.service : null, patch: d.requestPatch },
          // an urgent request is announced to the staff even when an open request of this chat already exists
          !!d.summary?.startsWith('ТЕРМІНОВО'));
      }
      return true;
    } catch (e) {
      // The reply allowance is used up: the conversation goes to a person, who sees a request (no debt, nothing is lost)
      if ((e as Error).message === 'ai_limit') await this.handOffNoAllowance(clinicId, channel, chatId).catch(() => undefined);
      else this.log.warn(`Автоответ не отправлен: ${(e as Error).message} (clinic ${clinicId}, ${channel})`);
      return false;
    }
  }
}
