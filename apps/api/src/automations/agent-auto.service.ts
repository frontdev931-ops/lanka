import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { bookingStatusOf } from '../ai/booking-status';
import { isPriceQuestion, languageOf } from '../ai/guardrails';
import { PrismaService } from '../prisma/prisma.service';
import { AgentApprovalService, ApprovalResult, Choice } from './agent-approval.service';
import { AgentAutoGate } from './agent-auto-gate';
import { RequestsService } from './requests.service';

const LEASE_MS = 90_000;
// After a finished booking these are answered by the code, without the model: a repeated "yes" (typed or the old button), thanks, and the old "no, another time" button
const YES_AGAIN = /^\s*(?:так|да|yes|ок|окей|добре|гаразд|підтверджую|подтверждаю|згоден|согласен|угу|ага)(?:[,\s]+(?:підтверджую|подтверждаю))?[\s.!)]*$/iu;
const THANKS = /^\s*(?:щиро\s+|дуже\s+|велике\s+|большое\s+)?(?:дякую|дякуємо|спасибі|спасибо|благодарю|thanks|thank you)(?:\s+(?:вам|за\s+все))?[\s!.,)]*$/iu;
const NO_BUTTON = /^(?:Ні, інший час|Нет, другое время)$/;
const AFTER_BOOKING = {
  uk: {
    again: (b: { service: string | null; date: string; time: string }) => `Ваш запис уже підтверджено: ${b.service ?? 'послуга'}, ${b.date} о ${b.time}. Додаткових дій не потрібно.`,
    thanks: 'Будь ласка! До зустрічі.',
    change: (b: { service: string | null; date: string; time: string }) => `Ваш запис підтверджено: ${b.service ?? 'послуга'}, ${b.date} о ${b.time}. Щоб змінити час або скасувати запис, напишіть, будь ласка, про це окремим повідомленням.`,
  },
  ru: {
    again: (b: { service: string | null; date: string; time: string }) => `Ваша запись уже подтверждена: ${b.service ?? 'услуга'}, ${b.date} в ${b.time}. Дополнительных действий не нужно.`,
    thanks: 'Пожалуйста! До встречи.',
    change: (b: { service: string | null; date: string; time: string }) => `Ваша запись подтверждена: ${b.service ?? 'услуга'}, ${b.date} в ${b.time}. Чтобы изменить время или отменить запись, напишите, пожалуйста, об этом отдельным сообщением.`,
  },
};
// The neutral text after an unclear correction of the contacts (said only after the request for the staff was really made)
const DATA_NOTICE = { uk: 'Передали ваше уточнення адміністратору. Він допоможе перевірити дані.', ru: 'Передали ваше уточнение администратору. Он поможет проверить данные.' };
// A message that is clearly not an answer to the data question: a decline, another wish, a request for a person (uk and ru). Such a message goes to the model.
const NOT_AN_ANSWER = /не\s+потрібно|не\s+треба|не\s+хочу|передума|подума|відмов|покличте|покликати|позвіть|адміністратор|людин|оператор|менеджер|не\s+нужно|не\s+надо|передумал|подумаю|откаж|позовите|позвать|человек|администратор/i;
// what one pass may do: each pass makes at most one send or one visit, then looks at the dialogue again
const MAX_STEPS = 6;
const MAX_ROUNDS = 4;

// The agent's limited AUTONOMOUS mode (off by default, see AgentAutoGate): the same steps a staff member approves with a button are executed here by the system,
// through the SAME execution (AgentApprovalService.approve with auto=true: the same checks, the same transport confirmation, the same BookingFlowService and
// BookingService for the visit), with the right to act checked again right before every send and every visit.
//
// One dialogue is processed by one worker at a time: a short LEASE on the dialogue's state row (a compare-and-set, never a database transaction held over a model
// or channel call). A message that arrives while the lease is held is already saved; after the holder lets go it looks again, so no message is lost. A holder that
// stopped leaves an expired lease: the next message or the sweep of the scheduler takes the dialogue over.
@Injectable()
export class AgentAutoService {
  private readonly log = new Logger(AgentAutoService.name);

  constructor(
    private prisma: PrismaService,
    private gate: AgentAutoGate,
    private approval: AgentApprovalService,
    private requests: RequestsService,
  ) {}

  // After an incoming message is saved and the booking flow has taken its part. Never throws (the webhook must not fail because of the agent).
  async onInbound(clinicId: string, channel: string, chatId: string): Promise<void> {
    try {
      if (await this.gate.denied(clinicId, channel, chatId)) return;
      await this.process(clinicId, channel, chatId);
    } catch (e) {
      this.log.warn(`Agent turn failed (clinic ${clinicId}, ${channel}): ${(e as Error).message}`);
    }
  }

  // The scheduler's pass: dialogs of the list with a message nobody handled (a worker stopped, or a lease was lost)
  async sweep(): Promise<number> {
    let n = 0;
    for (const key of (process.env.AGENT_AUTO_DIALOGS ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)) {
      const [clinicId, channel, chatId] = key.split('|');
      if (!clinicId || !channel || !chatId) continue;
      try {
        if (await this.gate.denied(clinicId, channel, chatId)) continue;
        if (!(await this.unseen(clinicId, channel, chatId))) continue;
        if (await this.process(clinicId, channel, chatId)) n++;
      } catch (e) {
        this.log.warn(`Agent sweep failed (clinic ${clinicId}, ${channel}): ${(e as Error).message}`);
      }
    }
    return n;
  }

  // true when this call took the dialogue (false: another worker holds it and will look at the new message after it lets go)
  async process(clinicId: string, channel: string, chatId: string): Promise<boolean> {
    let took = false;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const token = randomUUID();
      if (!(await this.claim(clinicId, channel, chatId, token))) return took;
      took = true;
      try {
        for (let i = 0; i < MAX_STEPS; i++) {
          if (!(await this.renew(clinicId, channel, chatId, token))) return took;
          if ((await this.step(clinicId, channel, chatId, token)) === 'stop') break;
        }
      } finally {
        await this.release(clinicId, channel, chatId, token);
      }
      // a message may have arrived after the last look and before the lease was let go: look once more, nothing is lost
      if (!(await this.unseen(clinicId, channel, chatId))) return took;
    }
    return took;
  }

  private key(clinicId: string, channel: string, chatId: string) {
    return { clinicId_channel_chatId: { clinicId, channel, chatId } };
  }

  private async claim(clinicId: string, channel: string, chatId: string, token: string): Promise<boolean> {
    await this.prisma.conversationState.upsert({ where: this.key(clinicId, channel, chatId), create: { clinicId, channel, chatId }, update: {} });
    const r = await this.prisma.conversationState.updateMany({
      where: { clinicId, channel, chatId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
      data: { leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS) },
    });
    return r.count === 1;
  }

  private async renew(clinicId: string, channel: string, chatId: string, token: string): Promise<boolean> {
    const r = await this.prisma.conversationState.updateMany({ where: { clinicId, channel, chatId, leaseToken: token }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } });
    return r.count === 1;
  }

  private async release(clinicId: string, channel: string, chatId: string, token: string) {
    await this.prisma.conversationState.updateMany({ where: { clinicId, channel, chatId, leaseToken: token }, data: { leaseToken: null, leaseUntil: null } });
  }

  // The last message of the dialogue (a failed or unknown send of ours is not part of it) when it is the patient's and nobody has handled it
  private async lastIncoming(clinicId: string, channel: string, chatId: string) {
    const last = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, NOT: { direction: 'OUT', error: { not: null } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true, direction: true, text: true } });
    return last && last.direction === 'IN' ? last : null;
  }

  private async unseen(clinicId: string, channel: string, chatId: string): Promise<boolean> {
    const last = await this.lastIncoming(clinicId, channel, chatId);
    if (!last) return false;
    const state = await this.prisma.conversationState.findUnique({ where: this.key(clinicId, channel, chatId), select: { autoSeenId: true, owner: true } });
    return state?.autoSeenId !== last.id && state?.owner !== 'HUMAN';
  }

  // One look at the dialogue and at most one action. 'stop': nothing more to do now. 'continue': look again (the dialogue changed while the action was prepared).
  private async step(clinicId: string, channel: string, chatId: string, token: string): Promise<'stop' | 'continue'> {
    // the right to act, first look (the approval checks it again right before the send and the visit)
    if (await this.gate.denied(clinicId, channel, chatId)) return 'stop';
    await this.approval.settle(clinicId, channel, chatId);
    const state = await this.prisma.conversationState.findUnique({ where: this.key(clinicId, channel, chatId) });
    if (!state || state.leaseToken !== token || state.owner === 'HUMAN') return 'stop';
    // an unfinished action (a send in progress, or a result nobody knows): the agent does nothing more here; an unknown result is a person's task
    const unfinished = await this.prisma.agentDraft.findFirst({ where: { clinicId, channel, chatId, status: { in: ['APPROVING', 'UNKNOWN'] } }, select: { status: true } });
    if (unfinished) {
      if (unfinished.status === 'UNKNOWN') await this.escalate(clinicId, channel, chatId, 'result_unknown');
      return 'stop';
    }
    const last = await this.lastIncoming(clinicId, channel, chatId);
    if (!last || state.autoSeenId === last.id) return 'stop';
    const seen = () => this.prisma.conversationState.updateMany({ where: { id: state.id, leaseToken: token }, data: { autoSeenAt: last.createdAt, autoSeenId: last.id } });

    // 1. a booking step of the open request (ask for the data, ask for the consent, create the visit after the consent)
    const asksQuestion = (last.text.includes('?') || isPriceQuestion(last.text)) && !last.text.startsWith('Обрав час:');
    const staged = await this.approval.stageStep(clinicId, channel, chatId);
    if (staged && 'note' in staged) {
      // identity not confirmed, urgent, no length, the time is gone, too many questions: a person's task
      if (staged.note === 'data_wrong') await this.handOverWithNotice(clinicId, channel, chatId, staged.note, last.text);
      else await this.escalate(clinicId, channel, chatId, staged.note);
      await seen();
      return 'stop';
    }
    // The data question is asked again only when the patient's message was an answer to it (it changed the request, or it is not clearly something else)
    // and was not a question: a decline, a request for a person, another wish or a question goes to the model, never back to the old step by force
    if (staged) {
      const dataStep = staged.choice === 'ASK_DATA';
      const openReq = dataStep ? await this.requests.openFor(clinicId, channel, chatId) : null;
      const gaveData = !!openReq && openReq.updatedAt.getTime() >= last.createdAt.getTime();
      if (!dataStep || (!asksQuestion && (gaveData || !NOT_AN_ANSWER.test(last.text)))) return this.after(await this.approval.approve(clinicId, null, staged.id, { revision: staged.revision, choice: staged.choice }, true), clinicId, channel, chatId, seen);
    }

    // A finished booking (the system's own record): a repeated "yes", thanks and the old "no" button get a short answer of the code, with no model, no new data collection and no
    // new offer; anything else (a new question) goes on to the model, which is told the booking's status
    const done = await bookingStatusOf(this.prisma, clinicId, channel, chatId);
    if (done?.kind === 'CONFIRMED') {
      const t = last.text.trim();
      const lang = languageOf([t]) === 'ru' ? 'ru' : 'uk';
      const text = NO_BUTTON.test(t) ? AFTER_BOOKING[lang].change(done) : THANKS.test(t) ? AFTER_BOOKING[lang].thanks : YES_AGAIN.test(t) || /^(?:Так, підтверджую|Да, подтверждаю)$/.test(t) ? AFTER_BOOKING[lang].again(done) : null;
      if (text) {
        const reply = await this.approval.stageReply(clinicId, channel, chatId, text);
        return this.after(await this.approval.approve(clinicId, null, reply.id, { revision: reply.revision, choice: 'SEND_REPLY' }, true), clinicId, channel, chatId, seen);
      }
    }
    // A tap on a confirmation button that the booking flow did not take (the button belongs to an earlier question: the data or the time changed since) is not a free
    // message: no answer of the model, and above all no new offer that would wipe the booking (the new question is the one that is open)
    if (/^(Так, підтверджую|Ні, інший час|Да, подтверждаю|Нет, другое время)$/.test(last.text.trim()) && (await this.requests.openFor(clinicId, channel, chatId))) {
      await seen();
      return 'stop';
    }
    // 2. an answer of the agent (the model decides the words and one action; the code executes only what is allowed)
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { aiRepliesPerChatDay: true } });
    const today = await this.prisma.chatMessage.count({ where: { clinicId, channel, chatId, byAi: true, createdAt: { gt: new Date(Date.now() - 86_400_000) } } });
    if (today >= clinic.aiRepliesPerChatDay) {
      await seen();
      return 'stop';
    }
    let view;
    try {
      view = await this.approval.create(clinicId, null, channel, chatId);
    } catch (e) {
      this.log.log(`Agent could not prepare an answer: ${(e as Error).message}`);
      await seen();
      return 'stop';
    }
    const choice: Choice | null = this.approval.autoChoice(view);
    if (!choice) {
      await this.escalate(clinicId, channel, chatId, 'unsupported');
      await seen();
      return 'stop';
    }
    const res = await this.approval.approve(clinicId, null, view.id, { revision: view.revision, choice }, true);
    // a question in the middle of the booking was answered: the pending step is asked again, once (the time and the service are kept; a decline, a request for
    // a person or a change of the wish are not sent back to the old step)
    if (res.outcome === 'SENT' && choice === 'SEND_REPLY' && asksQuestion) await this.resume(clinicId, channel, chatId, view.id);
    return this.after(res, clinicId, channel, chatId, seen);
  }

  private async resume(clinicId: string, channel: string, chatId: string, draftId: string) {
    const draft = await this.prisma.agentDraft.findUnique({ where: { id: draftId } });
    const snap = draft?.snapshot as { action?: string; contentKind?: string | null } | undefined;
    // only a plain answer (not a clarifying question, a doubt, a closing, a hand-over or a new offer of times)
    if (!snap || snap.action !== 'NONE' || !['ANSWER', 'EXPLAIN'].includes(snap.contentKind ?? '')) return;
    const answer = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'OUT', error: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    if (!answer) return;
    const staged = await this.approval.stageStep(clinicId, channel, chatId, answer.id);
    if (!staged || 'note' in staged) return;
    await this.approval.approve(clinicId, null, staged.id, { revision: staged.revision, choice: staged.choice }, true);
  }

  private async after(res: ApprovalResult, clinicId: string, channel: string, chatId: string, seen: () => Promise<unknown>): Promise<'stop' | 'continue'> {
    // the dialogue changed while the answer was prepared (a new message): it is looked at again, the new message is answered, nothing is dropped
    if (res.outcome === 'REFUSED' && (res.code === 'stale' || res.code === 'revision_changed' || res.code === 'step_changed')) return 'continue';
    await seen();
    // a refusal of the right to act that is not a withdrawn permission or a person's ownership (another service, ...) is told to the staff
    if (res.code === 'auto_not_allowed' && !(await this.gate.denied(clinicId, channel, chatId)) && (await this.prisma.conversationState.findUnique({ where: this.key(clinicId, channel, chatId), select: { owner: true } }))?.owner !== 'HUMAN') {
      await this.escalate(clinicId, channel, chatId, 'not_allowed');
    }
    if (res.outcome === 'UNKNOWN' || res.outcome === 'FAILED') await this.escalate(clinicId, channel, chatId, res.outcome === 'UNKNOWN' ? 'result_unknown' : 'send_failed');
    return 'stop';
  }

  // An unclear correction of the contacts: the request for the staff is made FIRST; only when it exists is the one neutral text sent (a hand-over that did not happen is
  // never announced), and the dialogue is a person's in every case
  private async handOverWithNotice(clinicId: string, channel: string, chatId: string, reason: string, lastText: string) {
    let made = false;
    try {
      const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { patientId: true } });
      const named = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, contactName: { not: null } }, orderBy: { createdAt: 'desc' }, select: { contactName: true } });
      await this.requests.upsert(clinicId, { channel, chatId, patientId: ch?.patientId ?? null, contactName: named?.contactName ?? null, kind: 'HANDOFF', summary: `Агент передав діалог співробітнику (${reason})` });
      made = true;
    } catch (e) {
      this.log.warn(`Request for the staff not made (${reason}): ${(e as Error).message}`);
    }
    try {
      if (made) {
        const lang = languageOf([lastText]) === 'ru' ? 'ru' : 'uk';
        const reply = await this.approval.stageReply(clinicId, channel, chatId, DATA_NOTICE[lang]);
        await this.approval.approve(clinicId, null, reply.id, { revision: reply.revision, choice: 'SEND_REPLY' }, true);
      }
    } catch (e) {
      this.log.warn(`Hand-over notice not sent: ${(e as Error).message}`);
    } finally {
      await this.prisma.conversationState.updateMany({ where: { clinicId, channel, chatId }, data: { owner: 'HUMAN' } });
    }
  }

  // A person's task now: a request for the staff (they are told once) and the dialogue is theirs until they give it back
  private async escalate(clinicId: string, channel: string, chatId: string, reason: string) {
    // the dialogue is a person's FIRST (whatever happens next, the agent does not go on selling); then the request for the staff, which may fail without changing that
    await this.prisma.conversationState.updateMany({ where: { clinicId, channel, chatId }, data: { owner: 'HUMAN' } });
    try {
      const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { patientId: true } });
      const named = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, contactName: { not: null } }, orderBy: { createdAt: 'desc' }, select: { contactName: true } });
      await this.requests.upsert(clinicId, { channel, chatId, patientId: ch?.patientId ?? null, contactName: named?.contactName ?? null, kind: 'HANDOFF', summary: `Агент передав діалог співробітнику (${reason})` });
    } catch (e) {
      this.log.warn(`Request for the staff not made (${reason}): ${(e as Error).message}`);
    }
  }
}
