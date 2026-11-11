import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { bookingStatusOf } from '../ai/booking-status';
import { conversationLanguage } from '../ai/conversation-language';
import { isPriceQuestion, languageOnlyRequest } from '../ai/guardrails';
import { PrismaService } from '../prisma/prisma.service';
import { AgentApprovalService, ApprovalResult, Choice } from './agent-approval.service';
import { AgentAutoGate } from './agent-auto-gate';
import { BookingFlowService } from './booking-flow.service';
import { RequestKind, RequestsService } from './requests.service';
import { ConversationVisit } from '../ai/booking-status';
import { ANY_TIME, TimePreference, parseTimePreference } from '../ai/time-preference';
import { matchDoctors } from '../booking/doctor-choice.service';
import { clinicDate } from '../common/clinic-time';
import { CANCEL_TEXT, CancelRef, MOVE_TEXT, MoveTo, asksToCancel, asksToMove, cancelRefOf, cancelStaffNote, cancelTapOf, moveStaffNote, moveTapOf, typedAnswer } from './visit-cancel';

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
// The visit could not be made for the settled doctor (he no longer provides the service, has no reliable schedule): said only after the staff request exists; no booking is claimed
const DOCTOR_NOTICE = { uk: 'Передали ваш запит адміністратору: він допоможе уточнити запис. Запис ще не підтверджено.', ru: 'Передали ваш запрос администратору: он поможет уточнить запись. Запись ещё не подтверждена.' };
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
    private flow: BookingFlowService,
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
    const last = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, NOT: { direction: 'OUT', error: { not: null } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true, direction: true, text: true, buttons: true } });
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

    // 0. moving or cancelling a visit THIS dialogue created: the questions, the patient's answers to them, the write (before the booking steps and the model)
    const change = (await this.moveTurn(clinicId, channel, chatId, last, seen)) ?? (await this.cancelTurn(clinicId, channel, chatId, last, seen));
    if (change) return change;

    // 1. a booking step of the open request (ask for the data, ask for the consent, create the visit after the consent)
    // (a message that only asks for a language is, like a question, not an answer to the open step: it is acknowledged and the step is asked again in that language)
    const asksQuestion = (last.text.includes('?') || isPriceQuestion(last.text) || !!languageOnlyRequest(last.text)) && !last.text.startsWith('Обрав час:');
    const staged = await this.approval.stageStep(clinicId, channel, chatId);
    if (staged && 'note' in staged) {
      // identity not confirmed, urgent, no length, the time is gone, too many questions: a person's task
      if (staged.note === 'data_wrong') await this.handOverWithNotice(clinicId, channel, chatId, staged.note, last.text);
      else if (staged.note === 'slot_gone') await this.offerAfterSlotGone(clinicId, channel, chatId);
      // doctors mode: the settled doctor can no longer be booked (no other doctor is put in his place): the staff request, then one short message to the patient
      else if (staged.note === 'not_possible' && (await this.doctorsMode(clinicId))) await this.handOverWithNotice(clinicId, channel, chatId, `not_possible: ${staged.detail ?? 'запис неможливий'}`, '', DOCTOR_NOTICE);
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
      const lang = await conversationLanguage(this.prisma, clinicId, channel, chatId);
      const text = NO_BUTTON.test(t) ? AFTER_BOOKING[lang].change(done) : THANKS.test(t) ? AFTER_BOOKING[lang].thanks : YES_AGAIN.test(t) || /^(?:Так, підтверджую|Да, подтверждаю)$/.test(t) ? AFTER_BOOKING[lang].again(done) : null;
      if (text) {
        const reply = await this.approval.stageReply(clinicId, channel, chatId, text);
        return this.after(await this.approval.approve(clinicId, null, reply.id, { revision: reply.revision, choice: 'SEND_REPLY' }, true), clinicId, channel, chatId, seen);
      }
    }
    // The visit of that booking was cancelled: a repeated "yes" or an old button of the booking neither books nor cancels anything; the code says what stands
    if (done?.kind === 'CANCELLED' && (YES_AGAIN.test(last.text.trim()) || NO_BUTTON.test(last.text.trim()) || /^(?:Так, підтверджую|Да, подтверждаю)$/.test(last.text.trim()))) {
      const lang = await conversationLanguage(this.prisma, clinicId, channel, chatId);
      return this.codeReply(clinicId, channel, chatId, `${CANCEL_TEXT[lang].already({ visitId: '', externalVisitId: '', startsAt: '', doctorId: null, doctor: null, service: done.service, date: done.date, time: done.time })} ${lang === 'ru' ? 'Если хотите записаться снова, напишите нам.' : 'Якщо хочете записатися знову, напишіть нам.'}`, seen);
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

  // Cancelling a visit of THIS dialogue (the first slice; any other visit, several visits and every rescheduling stay a staff task). null: not about it.
  //   - "cancel my visit" with exactly one future visit this dialogue created: the question "cancel this visit?" with its own buttons (nothing is written yet);
  //   - the "yes" button of THAT question, while it is our last message: the cancellation (fresh check of Cliniccards first), then "cancelled", only after success;
  //   - "no": the visit stays; an old or foreign button: nothing changes, said so; a typed "так" while the question is open: the question again (a bare yes cancels nothing).
  // What cannot be done here becomes ONE cancellation request for the staff with the visit's reference, and the dialogue is a person's.
  private async cancelTurn(clinicId: string, channel: string, chatId: string, last: { id: string; text: string; buttons: unknown }, seen: () => Promise<unknown>): Promise<'stop' | 'continue' | null> {
    let tap = cancelTapOf(last.buttons);
    // the words of a button typed in the other language (the same language is matched to the button by intake): an answer to the open question only
    const typed = tap ? null : typedAnswer(last.text);
    if (typed === 'cancelyes' || typed === 'cancelno') {
      const open = await this.approval.pendingCancelQuestion(clinicId, channel, chatId);
      if (open) tap = { yes: typed === 'cancelyes', askId: open.id };
    }
    const typedYes = !tap && YES_AGAIN.test(last.text.trim());
    if (!tap && !typedYes && !asksToCancel(last.text)) return null;
    const lang = await conversationLanguage(this.prisma, clinicId, channel, chatId);
    const T = CANCEL_TEXT[lang];
    const pending = await this.approval.pendingCancelQuestion(clinicId, channel, chatId);
    if (typedYes) {
      if (!pending) return null;
      const target = (await this.approval.cancelTargets(clinicId, channel, chatId)).find((v) => v.visitId === pending.cancel.visitId);
      if (!target) return this.codeReply(clinicId, channel, chatId, T.stale, seen);
      const q = await this.approval.stageCancelQuestion(clinicId, channel, chatId, target, lang, true);
      return this.after(await this.approval.approve(clinicId, null, q.id, { revision: q.revision, choice: q.choice }, true), clinicId, channel, chatId, seen);
    }
    if (tap) {
      if (!pending || pending.id !== tap.askId) {
        // the question was answered already (a repeated "yes" after the cancellation) or the button belongs to an older question
        const ref = await this.askOf(clinicId, channel, chatId, tap.askId);
        const visit = ref ? await this.prisma.visit.findFirst({ where: { clinicId, id: ref.visitId }, select: { status: true } }) : null;
        return this.codeReply(clinicId, channel, chatId, ref && visit?.status === 'CANCELLED' ? T.already(ref) : T.stale, seen);
      }
      if (!tap.yes) return this.codeReply(clinicId, channel, chatId, T.kept(pending.cancel), seen);
      const staged = await this.approval.stageCancelVisit(clinicId, channel, chatId, pending.id);
      if (!staged) {
        await seen();
        return 'stop';
      }
      const res = await this.approval.approve(clinicId, null, staged.id, { revision: staged.revision, choice: staged.choice }, true);
      if (res.outcome === 'REFUSED' && (res.code === 'stale' || res.code === 'revision_changed')) return 'continue';
      await seen();
      const refs = [{ requestId: pending.requestId, ref: pending.cancel }];
      if (res.outcome === 'SENT') {
        // the visit is cancelled: the message about it goes out once; if it cannot, the staff is told (the cancellation is NOT written again)
        const reply = await this.approval.stageReply(clinicId, channel, chatId, T.done(pending.cancel));
        const told = await this.approval.approve(clinicId, null, reply.id, { revision: reply.revision, choice: 'SEND_REPLY' }, true);
        if (told.outcome !== 'SENT') await this.handOverWithNotice(clinicId, channel, chatId, 'cancel_notice', '', null, { kind: 'CANCEL', summary: cancelStaffNote(refs, 'запис СКАСОВАНО в Cliniccards, але повідомлення пацієнту не надіслано: повідомте пацієнта') });
        return 'stop';
      }
      if (res.outcome === 'REFUSED' && res.code === 'in_progress') return 'stop';
      // the answer of Cliniccards is not known: the staff checks the visit; the patient is told nothing either way (an unfinished action also blocks every send)
      if (res.outcome === 'UNKNOWN') return this.cancelHandOver(clinicId, channel, chatId, refs, 'результат скасування невідомий (відповідь Cliniccards втрачено): перевірте візит у Cliniccards, повторно не скасовувалося', false);
      if (res.outcome === 'REFUSED' && res.code === 'auto_not_allowed' && (await this.gate.denied(clinicId, channel, chatId))) return 'stop';
      const why = res.outcome === 'FAILED' ? 'Cliniccards відмовив у скасуванні, запис не змінено' : res.code === 'visit_changed' ? 'візит змінено або не знайдено в Cliniccards, нічого не записано' : res.code === 'write_disabled' ? 'запис у Cliniccards вимкнено, нічого не записано' : `скасування не виконано (${res.reasons?.[0] ?? res.code ?? 'not_possible'}), нічого не записано`;
      return this.cancelHandOver(clinicId, channel, chatId, refs, why, true);
    }
    // "cancel my visit"
    const targets = await this.approval.cancelTargets(clinicId, channel, chatId);
    // not a visit of this dialogue: the model answers (the hand-over, as before; a visit is never looked for by a name or a phone)
    if (!targets.length) return null;
    const refs = targets.map((t) => ({ requestId: t.requestId, ref: cancelRefOf(t) }));
    if (targets.length > 1 || !(await this.approval.cancelWritable(clinicId, channel, chatId))) await seen();
    // several visits: in this slice none is chosen silently
    if (targets.length > 1) return this.cancelHandOver(clinicId, channel, chatId, refs, 'кілька майбутніх записів цього діалогу, агент не обирає', true);
    if (!(await this.approval.cancelWritable(clinicId, channel, chatId))) return this.cancelHandOver(clinicId, channel, chatId, refs, 'запис у Cliniccards вимкнено', true);
    const q = await this.approval.stageCancelQuestion(clinicId, channel, chatId, targets[0], lang);
    return this.after(await this.approval.approve(clinicId, null, q.id, { revision: q.revision, choice: q.choice }, true), clinicId, channel, chatId, seen);
  }

  // Moving a visit of THIS dialogue to another time (the same visit, service, doctor and length; several visits, another doctor or service, and every other visit
  // stay a staff task). null: not about it.
  //   - "move my visit" with exactly one future visit of the dialogue: the code's question "which day and time?" (no wish in the words) or the free times for the
  //     wish, found like a booking's (doctors mode: that doctor; cabinets: the service's cabinets);
  //   - a time of THAT offer: checked (read only), then "move: now → new time?" with its own buttons; the yes of THAT confirmation moves the visit (fresh checks
  //     first), then "moved", only after success. A typed button text counts like the button (both languages); a bare "так" asks the confirmation again.
  // What cannot be done becomes ONE reschedule request for the staff with the visit's reference, and the dialogue is a person's.
  private async moveTurn(clinicId: string, channel: string, chatId: string, last: { id: string; text: string; buttons: unknown }, seen: () => Promise<unknown>): Promise<'stop' | 'continue' | null> {
    let tap = moveTapOf(last.buttons);
    const typed = tap ? null : typedAnswer(last.text);
    const pending = await this.approval.pendingChange(clinicId, channel, chatId);
    const open = pending && ['ASK_MOVE_TIME', 'OFFER_MOVE', 'ASK_MOVE'].includes(pending.kind) ? pending : null;
    if (!tap && (typed === 'moveyes' || typed === 'moveno') && open?.kind === 'ASK_MOVE') tap = { kind: typed === 'moveyes' ? 'yes' : 'no', id: open.id };
    const typedYes = !tap && YES_AGAIN.test(last.text.trim());
    const asks = !tap && asksToMove(last.text);
    // nothing about a move: a message while an offer or a confirmation is open goes on as usual (the open question stays for its own buttons)
    if (!tap && !asks && !(open && (typedYes || open.kind === 'ASK_MOVE_TIME'))) return null;
    const lang = await conversationLanguage(this.prisma, clinicId, channel, chatId);
    const T = MOVE_TEXT[lang];
    const targets = await this.approval.cancelTargets(clinicId, channel, chatId);
    const targetOf = (visitId?: string) => targets.find((v) => v.visitId === visitId);
    if (tap) {
      const v = open && open.id === tap.id ? targetOf(open.step.visit?.visitId) : undefined;
      if (!open || !v || (tap.kind === 'slot') !== (open.kind === 'OFFER_MOVE') || (tap.kind !== 'slot' && open.kind !== 'ASK_MOVE')) return this.codeReply(clinicId, channel, chatId, T.stale, seen);
      const refs = [{ requestId: v.requestId, ref: cancelRefOf(v) }];
      if (tap.kind === 'slot') {
        const r = await this.approval.stageMoveConfirm(clinicId, channel, chatId, v, open.id, tap.date!, tap.time!, lang);
        if (r === 'stale') return this.codeReply(clinicId, channel, chatId, T.stale, seen);
        if (r === 'gone') return this.moveOffer(clinicId, channel, chatId, v, lang, null, seen, true);
        if ('note' in r) return this.moveHandOver(clinicId, channel, chatId, refs, r.note, true, seen);
        return this.after(await this.approval.approve(clinicId, null, r.id, { revision: r.revision, choice: r.choice }, true), clinicId, channel, chatId, seen);
      }
      if (tap.kind === 'no') return this.codeReply(clinicId, channel, chatId, T.kept(cancelRefOf(v)), seen);
      const to = open.step.to!;
      const staged = await this.approval.stageMoveVisit(clinicId, channel, chatId, open.id);
      if (!staged) {
        await seen();
        return 'stop';
      }
      const res = await this.approval.approve(clinicId, null, staged.id, { revision: staged.revision, choice: staged.choice }, true);
      if (res.outcome === 'REFUSED' && (res.code === 'stale' || res.code === 'revision_changed')) return 'continue';
      await seen();
      if (res.outcome === 'SENT') {
        // moved: the message about it goes out once; if it cannot, the staff is told (the move is NOT written again)
        const reply = await this.approval.stageReply(clinicId, channel, chatId, T.done(refs[0].ref, to));
        const told = await this.approval.approve(clinicId, null, reply.id, { revision: reply.revision, choice: 'SEND_REPLY' }, true);
        if (told.outcome !== 'SENT') await this.handOverWithNotice(clinicId, channel, chatId, 'move_notice', '', null, { kind: 'RESCHEDULE', summary: moveStaffNote(refs, 'запис ПЕРЕНЕСЕНО в Cliniccards, але повідомлення пацієнту не надіслано: повідомте пацієнта', to) });
        return 'stop';
      }
      if (res.outcome === 'REFUSED' && res.code === 'in_progress') return 'stop';
      if (res.outcome === 'UNKNOWN') return this.moveHandOver(clinicId, channel, chatId, refs, 'результат перенесення невідомий (відповідь Cliniccards втрачено): перевірте час візиту в Cliniccards, повторно не надсилалося', false, seen, to);
      // the new time was taken in the meantime: the original visit stays, fresh times are offered
      if (res.outcome === 'REFUSED' && res.code === 'slot_unavailable') return this.moveOffer(clinicId, channel, chatId, v, lang, null, seen, true);
      if (res.outcome === 'REFUSED' && res.code === 'auto_not_allowed' && (await this.gate.denied(clinicId, channel, chatId))) return 'stop';
      const why = res.outcome === 'FAILED' ? 'Cliniccards відмовив у перенесенні, запис не змінено' : res.code === 'visit_changed' ? 'візит змінено або не знайдено в Cliniccards, нічого не записано' : res.code === 'write_disabled' ? 'запис у Cliniccards вимкнено, нічого не записано' : `перенесення не виконано (${res.reasons?.[0] ?? res.code ?? 'not_possible'}), нічого не записано`;
      return this.moveHandOver(clinicId, channel, chatId, refs, why, true, seen, to);
    }
    if (typedYes && !asks) {
      // a bare yes while the confirmation is open: the confirmation again (it is not a yes to it)
      const v = open?.kind === 'ASK_MOVE' ? targetOf(open.step.visit?.visitId) : undefined;
      if (!v || !open?.step.to) return null;
      const r = await this.approval.stageMoveConfirm(clinicId, channel, chatId, v, '', '', '', lang, open.step.to);
      if (typeof r === 'string' || 'note' in r) return null;
      return this.after(await this.approval.approve(clinicId, null, r.id, { revision: r.revision, choice: r.choice }, true), clinicId, channel, chatId, seen);
    }
    const today = clinicDate(new Date());
    if (!asks && open?.kind === 'ASK_MOVE_TIME') {
      // the answer to "which day and time?": a wish the code can read, or "any time"; anything else goes on as usual
      const pref = parseTimePreference(last.text, today);
      const v = targetOf(open.step.visit?.visitId);
      if (!v || (!(pref && !pref.unclear) && !ANY_TIME.test(last.text))) return null;
      return this.moveOffer(clinicId, channel, chatId, v, lang, ANY_TIME.test(last.text) ? null : pref, seen);
    }
    // "move my visit"
    if (!targets.length) return null;
    const refs = targets.map((t) => ({ requestId: t.requestId, ref: cancelRefOf(t) }));
    if (targets.length > 1) return this.moveHandOver(clinicId, channel, chatId, refs, 'кілька майбутніх записів цього діалогу, агент не обирає', true, seen);
    const v = targets[0];
    if (!(await this.approval.cancelWritable(clinicId, channel, chatId))) return this.moveHandOver(clinicId, channel, chatId, refs, 'запис у Cliniccards вимкнено', true, seen);
    // another doctor named: not a move of this visit (the doctor is never changed here)
    const doctors = await this.prisma.doctor.findMany({ where: { clinicId, active: true }, select: { externalId: true, lastName: true, firstName: true } });
    if (matchDoctors(last.text, doctors).some((id) => id !== v.doctorId)) return this.moveHandOver(clinicId, channel, chatId, refs, 'пацієнт називає іншого лікаря: зміна лікаря — завдання персоналу', true, seen);
    const pref = parseTimePreference(last.text, today);
    if (!pref || pref.unclear) {
      const q = await this.approval.stageMoveTimeQuestion(clinicId, channel, chatId, v, lang);
      return this.after(await this.approval.approve(clinicId, null, q.id, { revision: q.revision, choice: q.choice }, true), clinicId, channel, chatId, seen);
    }
    return this.moveOffer(clinicId, channel, chatId, v, lang, pref, seen);
  }

  // the new times for the visit, or (none for the wish in the searched range) the staff request
  private async moveOffer(clinicId: string, channel: string, chatId: string, v: ConversationVisit, lang: 'uk' | 'ru', pref: TimePreference | null, seen: () => Promise<unknown>, gone = false): Promise<'stop' | 'continue'> {
    const o = await this.approval.stageMoveOffer(clinicId, channel, chatId, v, lang, pref, gone);
    if (!o) return this.moveHandOver(clinicId, channel, chatId, [{ requestId: v.requestId, ref: cancelRefOf(v) }], pref ? 'немає вільного часу за побажанням пацієнта в межах пошуку' : 'немає вільного часу в межах пошуку', true, seen);
    return this.after(await this.approval.approve(clinicId, null, o.id, { revision: o.revision, choice: o.choice }, true), clinicId, channel, chatId, seen);
  }

  private async moveHandOver(clinicId: string, channel: string, chatId: string, refs: { requestId: string; ref: CancelRef }[], why: string, tell: boolean, seen: () => Promise<unknown>, to?: MoveTo): Promise<'stop'> {
    await seen();
    await this.handOverWithNotice(clinicId, channel, chatId, 'move', '', tell ? { uk: MOVE_TEXT.uk.handed, ru: MOVE_TEXT.ru.handed } : null, { kind: 'RESCHEDULE', summary: moveStaffNote(refs, why, to) });
    return 'stop';
  }

  // what a question of cancelling was about (for an old button)
  private async askOf(clinicId: string, channel: string, chatId: string, askId: string): Promise<CancelRef | null> {
    const d = await this.prisma.agentDraft.findFirst({ where: { id: askId, clinicId, channel, chatId }, select: { snapshot: true } });
    return (d?.snapshot as { step?: { cancel?: CancelRef } } | undefined)?.step?.cancel ?? null;
  }

  // one cancellation request for the staff (the visit's reference and why), then, when nothing was written, one short message (`tell`), and the dialogue is a person's
  private async cancelHandOver(clinicId: string, channel: string, chatId: string, refs: { requestId: string; ref: CancelRef }[], why: string, tell: boolean): Promise<'stop'> {
    await this.handOverWithNotice(clinicId, channel, chatId, 'cancel', '', tell ? { uk: CANCEL_TEXT.uk.handed, ru: CANCEL_TEXT.ru.handed } : null, { kind: 'CANCEL', summary: cancelStaffNote(refs, why) });
    return 'stop';
  }

  // a short answer of the code, sent by the same execution as every other message
  private async codeReply(clinicId: string, channel: string, chatId: string, text: string, seen: () => Promise<unknown>): Promise<'stop' | 'continue'> {
    const reply = await this.approval.stageReply(clinicId, channel, chatId, text);
    return this.after(await this.approval.approve(clinicId, null, reply.id, { revision: reply.revision, choice: 'SEND_REPLY' }, true), clinicId, channel, chatId, seen);
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
    // the chosen time was taken when the visit was to be made: the patient is told and gets fresh times (nothing was created)
    if (res.code === 'slot_unavailable') await this.offerAfterSlotGone(clinicId, channel, chatId);
    // doctors mode: the visit could not be made for the settled doctor (he no longer provides the service, has no reliable schedule, is gone): never another doctor
    // by itself, a person takes it now
    // the request for the staff is made first (with the reason the booking flow stored), the patient is told only when it exists, the dialogue is a person's either way
    if (res.code === 'not_possible' && (await this.doctorsMode(clinicId))) {
      // the reason: what the write stored, or what the booking plan reads now (the refusal may come from the freshness check before the write)
      const open = await this.requests.openFor(clinicId, channel, chatId);
      const plan = open ? await this.flow.agentPlan(clinicId, open.id).catch(() => null) : null;
      const why = open?.autoNote ?? (plan?.step === 'NOTE' ? (plan.detail ?? plan.note) : null);
      await this.handOverWithNotice(clinicId, channel, chatId, why ? `not_possible: ${why}` : 'not_possible', '', DOCTOR_NOTICE);
    }
    if (res.outcome === 'UNKNOWN' || res.outcome === 'FAILED') await this.escalate(clinicId, channel, chatId, res.outcome === 'UNKNOWN' ? 'result_unknown' : 'send_failed');
    return 'stop';
  }

  // An unclear correction of the contacts: the request for the staff is made FIRST; only when it exists is the one neutral text sent (a hand-over that did not happen is
  // never announced), and the dialogue is a person's in every case
  private async doctorsMode(clinicId: string): Promise<boolean> {
    return (await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { scheduleMode: true } }))?.scheduleMode === 'DOCTORS';
  }

  // (`request`: another kind of staff request with its own summary, e.g. a cancellation with the visit's reference; `notice` null: nothing is said to the patient)
  private async handOverWithNotice(clinicId: string, channel: string, chatId: string, reason: string, lastText: string, notice: Record<'uk' | 'ru', string> | null = DATA_NOTICE, request?: { kind: RequestKind; summary: string }) {
    let made = false;
    try {
      const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { patientId: true } });
      const named = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, contactName: { not: null } }, orderBy: { createdAt: 'desc' }, select: { contactName: true } });
      await this.requests.upsert(clinicId, { channel, chatId, patientId: ch?.patientId ?? null, contactName: named?.contactName ?? null, kind: request?.kind ?? 'HANDOFF', summary: request?.summary ?? `Агент передав діалог співробітнику (${reason})` });
      made = true;
    } catch (e) {
      this.log.warn(`Request for the staff not made (${reason}): ${(e as Error).message}`);
    }
    try {
      if (made && notice) {
        const lang = await conversationLanguage(this.prisma, clinicId, channel, chatId);
        const reply = await this.approval.stageReply(clinicId, channel, chatId, notice[lang]);
        await this.approval.approve(clinicId, null, reply.id, { revision: reply.revision, choice: 'SEND_REPLY' }, true);
      }
    } catch (e) {
      this.log.warn(`Hand-over notice not sent: ${(e as Error).message}`);
    } finally {
      await this.prisma.conversationState.updateMany({ where: { clinicId, channel, chatId }, data: { owner: 'HUMAN' } });
    }
  }

  // The chosen time is gone: say so and offer fresh times (or, with none, ask whether to pass the request to the administrator); only when even that cannot be done it is a person's task
  private async offerAfterSlotGone(clinicId: string, channel: string, chatId: string) {
    try {
      const staged = await this.approval.stageSlotGone(clinicId, channel, chatId);
      if (staged) {
        const res = await this.approval.approve(clinicId, null, staged.id, { revision: staged.revision, choice: staged.choice }, true);
        if (res.outcome === 'SENT') return;
      }
    } catch (e) {
      this.log.warn(`Fresh times after a taken slot not offered: ${(e as Error).message}`);
    }
    await this.escalate(clinicId, channel, chatId, 'slot_gone');
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
