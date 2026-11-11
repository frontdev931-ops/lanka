import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AgentDraft as AgentDraftRow, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AgentDraft, AgentDraftService, DraftBasis, DraftExec } from '../ai/agent-draft.service';
import { ConversationVisit, conversationVisits } from '../ai/booking-status';
import { AutoBookingGate } from '../booking/auto-booking-gate';
import { BookingService } from '../booking/booking.service';
import { conversationLanguage } from '../ai/conversation-language';
import { PrismaService } from '../prisma/prisma.service';
import { FunnelEventsService } from '../funnel-events/funnel-events.service';
import { SendError, slotPayload } from './channels';
import { MessengerService } from './messenger.service';
import { AgentAutoGate } from './agent-auto-gate';
import { AgentNote, BookingFlowService, BookingSummary } from './booking-flow.service';
import { RequestsService } from './requests.service';
import { CANCEL_TEXT, CancelRef, MOVE_TEXT, MoveTo, asksToCancel, cancelKeyOf, cancelRefOf, cancelStaffNote } from './visit-cancel';
import { TimePreference } from '../ai/time-preference';
import { clinicDate, clinicHm, localToUtc } from '../common/clinic-time';

// Review and approval of the agent's draft by a staff member (Stage 2). Generating a draft executes nothing; here a person reads it, sees what it would do and
// presses ONE button. Only three things can be executed: send the reply, send the offered times, hand over to the administrator. Nothing here creates a visit,
// and a staff approval is NOT the patient's consent to a booking.
export const CHOICES = ['SEND_REPLY', 'SEND_TIMES', 'HAND_OFF', 'ASK_DATA', 'ASK_CONSENT', 'CREATE_VISIT', 'ASK_CANCEL', 'CANCEL_VISIT', 'ASK_MOVE_TIME', 'OFFER_MOVE', 'ASK_MOVE', 'MOVE_VISIT'] as const;
export type Choice = (typeof CHOICES)[number];
// The steps that change an EXISTING visit of the dialogue (cancel, move) exist only for the autonomous mode (a staff member uses the booking screen's own action)
const CANCEL_STEPS = ['ASK_CANCEL', 'CANCEL_VISIT', 'ASK_MOVE_TIME', 'OFFER_MOVE', 'ASK_MOVE', 'MOVE_VISIT'];
// the steps that write to Cliniccards themselves (no message)
const WRITE_STEPS = ['CANCEL_VISIT', 'MOVE_VISIT'];

const STUCK_MS = 2 * 60_000;
const KEEP_DAYS = 30;
const EVAL_MS = 60_000;

// What is stored with a draft (no history of the conversation)
interface Snapshot {
  status: 'READY' | 'SAFE_FALLBACK';
  reply: string;
  action: string;
  proposed: string | null;
  contentKind: string | null;
  // (doctors mode: each time carries its doctor, the button's payload holds it)
  options: { label: string; date: string; time: string; doctorId?: string }[];
  serviceTitle: string | null;
  handoffReason: string | null;
  checkRejected: string | null;
  exec: DraftExec;
  allowed: Choice[];
  // the action of the draft needs a part of the product that is not connected to drafts yet (asking the consent, collecting the data)
  unsupported: boolean;
  // A booking step made by the code from the request of the dialogue (not by the model): ask for the missing data, ask the patient to confirm the booking, create the visit
  // (ASK_CANCEL / CANCEL_VISIT: the question about cancelling a visit of this dialogue and the cancellation after its "yes"; requestId is the booking request that
  // created the visit, key the revision of the visit asked about, cancel what it is, askId the question a cancellation answers)
  // (ASK_MOVE_TIME / OFFER_MOVE / ASK_MOVE / MOVE_VISIT: the same for moving it; visit is the visit as asked about, to the proposed new time)
  step?: { kind: 'ASK_DATA' | 'ASK_CONSENT' | 'CREATE_VISIT' | 'NOTE' | 'ASK_CANCEL' | 'CANCEL_VISIT' | 'ASK_MOVE_TIME' | 'OFFER_MOVE' | 'ASK_MOVE' | 'MOVE_VISIT'; requestId: string; key: string; consentKey?: string; text?: string; field?: string; asks?: number; options?: { label: string; date: string; time: string; payload?: string }[]; summary?: BookingSummary; note?: AgentNote; detail?: string; resume?: string; cancel?: CancelRef; askId?: string; visit?: CancelRef; to?: MoveTo };
}

// Channels whose send errors are told apart reliably (a clear refusal before sending vs no clear answer). Viber is not: its partner is not chosen and its adapter
// calls every error "not sent", so a retry could not be called safe; approval of drafts is off for it until it is classified.
const APPROVAL_CHANNELS = ['TELEGRAM', 'INSTAGRAM', 'MESSENGER', 'WHATSAPP', 'WEB'];

export type RefusalCode = 'visit_changed' | 'auto_not_allowed' | 'step_changed' | 'identity_needed' | 'write_disabled' | 'consent_missing' | 'consent_changed' | 'slot_unavailable' | 'not_possible' | 'channel_not_supported' | 'delivery_unverified' | 'stale' | 'content_changed' | 'options_changed' | 'options_unavailable' | 'sending_disabled' | 'opted_out' | 'agent_mode_off' | 'revision_changed' | 'in_progress' | 'not_active' | 'unsupported' | 'not_allowed';

export interface DraftView {
  id: string;
  revision: number;
  status: string;
  // what the patient would receive for each button that is offered
  previews: Partial<Record<Choice, string>>;
  allowed: Choice[];
  // for the screen to describe the action in its own words (never shown raw)
  kind: 'reply' | 'times' | 'handoff' | 'close' | 'unsupported' | 'fallback' | 'ask_data' | 'ask_consent' | 'create_visit' | 'note';
  // the booking steps: what the visit would be (as the patient gave it), and why a note has no button
  booking: BookingSummary | null;
  note: string | null;
  options: string[];
  handoffReason: string | null;
  unsupported: boolean;
  stale: { stale: boolean; reasons: string[] };
  // an earlier approval in this chat ended with an unknown result: delivery must be checked by a person before the same action is approved again
  unverified: { id: string; choice: Choice | null } | null;
  // approval of agent drafts is not offered for this channel
  channelSupported: boolean;
  // fields the old screen reads
  agent: true;
  reply: string;
  handoff: boolean;
  reason: string | null;
}

export interface ApprovalResult {
  ok: boolean;
  outcome: 'SENT' | 'FAILED' | 'UNKNOWN' | 'REFUSED';
  code?: RefusalCode;
  reasons?: string[];
  already?: boolean;
  // CREATE_VISIT: the visit exists; `notice` is the state of the message to the patient about it (SENT, FAILED, SKIPPED, PENDING): a failed message does not undo the visit
  booking?: { visit: string | null; notice: string | null; requestId: string | null };
  draft: DraftView | null;
}

@Injectable()
export class AgentApprovalService {
  private readonly log = new Logger(AgentApprovalService.name);
  private readonly evaluated = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private agent: AgentDraftService,
    private messenger: MessengerService,
    private requests: RequestsService,
    private funnel: FunnelEventsService,
    private flow: BookingFlowService,
    private gate: AgentAutoGate,
    private booking: BookingService,
    private autoBooking: AutoBookingGate,
  ) {}

  // ---- making and reading drafts ----

  // The draft of the agent for this chat, stored for review. Earlier waiting drafts of the chat are superseded. Nothing is executed.
  async create(clinicId: string, userId: string | null, channel: string, chatId: string): Promise<DraftView> {
    const d = await this.agent.generate(clinicId, channel, chatId);
    const snapshot = this.snapshotOf(d);
    await this.prisma.agentDraft.updateMany({ where: { clinicId, channel, chatId, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
    const row = await this.prisma.agentDraft.create({
      data: { clinicId, channel, chatId, basisMessageId: d.basis.lastMessageId, basisAt: new Date(d.basis.lastMessageAt), stateVersion: d.basis.stateVersion, basisOwner: d.basis.owner, createdById: userId, snapshot: snapshot as unknown as Prisma.InputJsonValue },
    });
    return this.view(row);
  }

  // The draft that is still waiting (or whose result is not clear) for this chat, with the freshness checked now
  async latest(clinicId: string, channel: string, chatId: string): Promise<DraftView | null> {
    await this.settleStuck(clinicId, channel, chatId);
    await this.ensureStep(clinicId, channel, chatId).catch((e) => this.log.warn(`Booking step not staged: ${(e as Error).message}`));
    const row = await this.prisma.agentDraft.findFirst({ where: { clinicId, channel, chatId, status: { in: ['PENDING', 'APPROVING', 'UNKNOWN'] } }, orderBy: { createdAt: 'desc' } });
    return row ? this.view(row) : null;
  }

  async reject(clinicId: string, id: string): Promise<{ ok: boolean; status: string }> {
    const row = await this.prisma.agentDraft.findFirst({ where: { id, clinicId } });
    if (!row) throw new NotFoundException('draft_not_found');
    // only a waiting draft is rejected; nothing is sent, created or changed in the dialogue
    const r = await this.prisma.agentDraft.updateMany({ where: { id, clinicId, status: 'PENDING' }, data: { status: 'REJECTED' } });
    return { ok: r.count === 1 || row.status === 'REJECTED', status: r.count === 1 ? 'REJECTED' : row.status };
  }

  // ---- approval ----

  // `auto`: the same execution on behalf of the agent's AUTONOMOUS mode (userId null): the checks are the same, plus the right to act (autoRight): a staff
  // member's intervention, an unfinished action and a changed permission stop it
  async approve(clinicId: string, userId: string | null, id: string, body: { revision: number; choice: Choice }, auto = false): Promise<ApprovalResult> {
    const row = await this.prisma.agentDraft.findFirst({ where: { id, clinicId } });
    if (!row) throw new NotFoundException('draft_not_found');
    const refuse = async (code: RefusalCode, reasons?: string[], fresh?: AgentDraftRow): Promise<ApprovalResult> => ({ ok: false, outcome: 'REFUSED', code, ...(reasons ? { reasons } : {}), draft: await this.view(fresh ?? row) });

    // a draft that was already acted on answers with what happened (a repeated click or a second request never acts again)
    if (row.status === 'SENT') return { ok: true, outcome: 'SENT', already: true, draft: null };
    if (row.status === 'FAILED') return { ok: false, outcome: 'FAILED', already: true, draft: null };
    if (row.status === 'UNKNOWN') return { ok: false, outcome: 'UNKNOWN', already: true, draft: await this.view(row) };
    if (row.status === 'APPROVING') {
      if (Date.now() - row.updatedAt.getTime() < STUCK_MS) return refuse('in_progress');
      await this.settleStuck(clinicId, row.channel, row.chatId);
      const after = await this.prisma.agentDraft.findUniqueOrThrow({ where: { id } });
      return after.status === 'SENT' ? { ok: true, outcome: 'SENT', already: true, draft: null } : { ok: false, outcome: 'UNKNOWN', draft: await this.view(after) };
    }
    if (row.status !== 'PENDING') return refuse('not_active');
    const snap = row.snapshot as unknown as Snapshot;
    // creating the visit sends nothing itself (the message about it goes through the booking flow's own, separately tracked delivery); every other step is a message
    const visit = body.choice === 'CREATE_VISIT';
    if (!visit && !APPROVAL_CHANNELS.includes(row.channel)) return refuse('channel_not_supported');
    // the approval is valid only for the revision the staff member saw
    if (body.revision !== row.revision) return refuse('revision_changed');
    if (snap.unsupported || !snap.allowed.includes(body.choice)) return refuse(snap.unsupported ? 'unsupported' : 'not_allowed');
    const cancelStep = !!snap.step && CANCEL_STEPS.includes(snap.step.kind);
    if (cancelStep && !auto) return refuse('not_allowed');

    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { sendingEnabled: true, aiAgentMode: true } });
    if (!clinic.aiAgentMode) return refuse('agent_mode_off');
    if (!clinic.sendingEnabled && !visit) return refuse('sending_disabled');
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel: row.channel, externalId: row.chatId }, select: { optedOutAt: true, patientId: true } });
    if (ch?.optedOutAt && !visit) return refuse('opted_out');

    // The same action must not go out twice because a NEW draft was made: while an earlier approval of this action in this chat is in flight or its result is
    // unknown, a person has to check the delivery first (resolve). Other actions and the manual reply are not blocked, and the block ends as soon as it is resolved.
    await this.settleStuck(clinicId, row.channel, row.chatId);
    // (a visit has its own protection: one unique attempt key and a check of the clinic's system before any retry)
    const open = visit ? null : await this.prisma.agentDraft.findFirst({ where: { clinicId, channel: row.channel, chatId: row.chatId, id: { not: id }, choice: body.choice, status: { in: ['APPROVING', 'UNKNOWN'] } } });
    if (open) return refuse(open.status === 'APPROVING' ? 'in_progress' : 'delivery_unverified');

    // freshness: the dialogue, the prices, the offered times (a staff member acts by their own rights: a human owner of the dialogue does not stop them)
    const check = await this.freshness(row, snap, body.choice, false, auto);
    if (check.refuse) {
      // a cancellation step is made for one moment of one visit: refused, it is not kept waiting for a later "yes"
      if (cancelStep) await this.prisma.agentDraft.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
      return refuse(check.refuse, check.reasons, check.fresh);
    }

    // one approval at a time: the claim is a compare-and-set on the status and the revision; nothing is held open while the message goes out
    const claim = await this.prisma.agentDraft.updateMany({ where: { id, status: 'PENDING', revision: row.revision }, data: { status: 'APPROVING', approvedById: userId, approvedAt: new Date(), choice: body.choice } });
    if (!claim.count) return refuse('in_progress');
    // the right to act is checked once more right before anything is sent
    const again = await this.freshness(row, snap, body.choice, true, auto);
    if (again.refuse) {
      await this.prisma.agentDraft.updateMany({ where: { id, status: 'APPROVING' }, data: { status: cancelStep || again.refuse === 'content_changed' || again.refuse === 'options_unavailable' || again.refuse === 'slot_unavailable' ? 'SUPERSEDED' : 'PENDING', approvedById: null, approvedAt: null, choice: null } });
      return refuse(again.refuse, again.reasons, again.fresh);
    }
    const out = snap.step ? await this.executeStep(row, snap, body.choice, userId, ch?.patientId ?? null, auto) : await this.execute(row, snap, body.choice, userId, ch?.patientId ?? null, auto);
    // A hand-over done by the autonomous mode ends its work in this dialogue: the dialogue is a person's until they give it back explicitly (later messages are
    // saved for the staff and do not start an answer of the agent)
    if (auto && body.choice === 'HAND_OFF' && out.outcome === 'SENT') {
      await this.prisma.conversationState.upsert({ where: { clinicId_channel_chatId: { clinicId, channel: row.channel, chatId: row.chatId } }, create: { clinicId, channel: row.channel, chatId: row.chatId, owner: 'HUMAN' }, update: { owner: 'HUMAN' } });
    }
    // A staff member's own action in a dialogue of the autonomous mode is an intervention: the dialogue is theirs until they give it back
    if (!auto && userId && out.outcome === 'SENT' && (await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { aiAgentAuto: true } }))?.aiAgentAuto) {
      await this.prisma.conversationState.upsert({ where: { clinicId_channel_chatId: { clinicId, channel: row.channel, chatId: row.chatId } }, create: { clinicId, channel: row.channel, chatId: row.chatId, owner: 'HUMAN' }, update: { owner: 'HUMAN' } });
    }
    return out;
  }

  // A person checked the chat after an unknown result. NOT_DELIVERED ends the block (the same action may be approved again); DELIVERED completes the draft as sent.
  async resolve(clinicId: string, userId: string, id: string, outcome: 'DELIVERED' | 'NOT_DELIVERED'): Promise<{ ok: boolean; status: string }> {
    const row = await this.prisma.agentDraft.findFirst({ where: { id, clinicId } });
    if (!row) throw new NotFoundException('draft_not_found');
    if (row.status !== 'UNKNOWN') return { ok: false, status: row.status };
    // the result of a visit is not told by a person: it is checked in the clinic's system (recheck)
    const kindOf = (row.snapshot as unknown as Snapshot).step?.kind;
    if (kindOf === 'CREATE_VISIT' || (kindOf && WRITE_STEPS.includes(kindOf))) return { ok: false, status: row.status };
    if (outcome === 'NOT_DELIVERED') {
      const r = await this.prisma.agentDraft.updateMany({ where: { id, clinicId, status: 'UNKNOWN' }, data: { status: 'CLEARED', error: `checked_not_delivered:${userId}` } });
      return { ok: r.count === 1, status: 'CLEARED' };
    }
    const r = await this.prisma.agentDraft.updateMany({ where: { id, clinicId, status: 'UNKNOWN' }, data: { status: 'SENT', error: `confirmed_delivered:${userId}` } });
    if (r.count === 1) await this.completeSent(row, null);
    return { ok: r.count === 1, status: 'SENT' };
  }

  // An approval that stopped half-way (the server stopped between the send and the saved result) stays APPROVING. It is completed as SENT only on the stored
  // confirmation of the transport for THIS attempt (`transportConfirmedAt`, written right after the channel answered). A message in our own table proves nothing
  // (it is written by the same code that may have stopped, and an identical text may come from a manual reply): without the confirmation the result is UNKNOWN
  // and nothing is sent again.
  private async settleStuck(clinicId: string, channel: string, chatId: string) {
    const rows = await this.prisma.agentDraft.findMany({ where: { clinicId, channel, chatId, status: 'APPROVING', updatedAt: { lt: new Date(Date.now() - STUCK_MS) } } });
    for (const row of rows) {
      if (!row.transportConfirmedAt) {
        await this.prisma.agentDraft.updateMany({ where: { id: row.id, status: 'APPROVING' }, data: { status: 'UNKNOWN', error: 'interrupted' } });
        continue;
      }
      const r = await this.prisma.agentDraft.updateMany({ where: { id: row.id, status: 'APPROVING' }, data: { status: 'SENT', error: 'recovered' } });
      if (r.count !== 1) continue;
      const messageId = await this.ensureMessage(row);
      await this.prisma.agentDraft.updateMany({ where: { id: row.id }, data: { messageId } });
      await this.completeSent({ ...row, messageId }, messageId);
    }
  }

  // The thread must show a message the channel accepted. The record is looked for by this attempt (author, text, time after the approval); when it was never
  // written it is written now.
  private async ensureMessage(row: AgentDraftRow): Promise<string> {
    const snap = row.snapshot as unknown as Snapshot;
    const choice = row.choice as Choice;
    const text = choice === 'HAND_OFF' ? snap.exec.handoffText : snap.reply;
    const found = await this.prisma.chatMessage.findFirst({ where: { clinicId: row.clinicId, channel: row.channel, chatId: row.chatId, direction: 'OUT', text, authorUserId: row.approvedById, createdAt: { gte: row.approvedAt ?? row.createdAt } }, orderBy: { createdAt: 'desc' } });
    if (found) {
      if (found.error) await this.prisma.chatMessage.update({ where: { id: found.id }, data: { error: null } });
      return found.id;
    }
    const options = choice === 'SEND_TIMES' ? snap.options : CANCEL_STEPS.includes(choice) && snap.step?.options ? snap.step.options : choice === 'SEND_REPLY' && snap.exec.buttons?.length ? snap.exec.buttons.map((b) => ({ label: b.label, date: '', time: '', payload: b.payload })) : [];
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId: row.clinicId, channel: row.channel, externalId: row.chatId }, select: { patientId: true } });
    const msg = await this.prisma.chatMessage.create({ data: { clinicId: row.clinicId, channel: row.channel, chatId: row.chatId, direction: 'OUT', text, authorUserId: row.approvedById, patientId: ch?.patientId ?? null, ...(options.length ? { buttons: options.map((o) => ({ label: o.label, payload: slotPayload(o) })) } : {}) } });
    return msg.id;
  }

  // what a real successful action leaves behind: the dialogue memory and the funnel events (the latter follow the clinic's own switch)
  private async completeSent(row: AgentDraftRow, messageId: string | null) {
    const snap = row.snapshot as unknown as Snapshot;
    const choice = row.choice as Choice | null;
    if (!choice) return;
    const { clinicId, channel, chatId, id } = row;
    let mid = messageId;
    if (!mid) {
      const unknownMsg = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'OUT', error: 'result_unknown', createdAt: { gte: row.approvedAt ?? row.createdAt } }, orderBy: { createdAt: 'desc' } });
      if (unknownMsg) {
        await this.prisma.chatMessage.update({ where: { id: unknownMsg.id }, data: { error: null } });
        mid = unknownMsg.id;
      }
      await this.prisma.agentDraft.updateMany({ where: { id }, data: { messageId: mid } });
    }
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { patientId: true } });
    if (snap.step) {
      const st = snap.step;
      if (choice === 'ASK_DATA') await this.flow.afterAskData(clinicId, st.requestId, st.asks ?? 0, st.field ?? 'all');
      if (choice === 'ASK_CONSENT') {
        await this.flow.afterConsentAsked(clinicId, st.requestId, st.consentKey ?? '', mid ?? `draft:${id}`);
        await this.rememberStage(clinicId, channel, chatId, 'CONSENT', st.requestId);
      }
      return;
    }
    await this.remember(clinicId, channel, chatId, snap, choice, mid ?? `draft:${id}`).catch((e) => this.log.warn(`Dialogue state not updated: ${(e as Error).message}`));
    // doctors mode: the doctor decision this message showed is saved now that it was really sent (before the offer is bound: the request may only now exist)
    if (snap.exec.doctorPatch && (choice === 'SEND_REPLY' || choice === 'SEND_TIMES')) await this.flow.applyDoctorPatch(clinicId, channel, chatId, snap.serviceTitle, snap.exec.doctorPatch).catch((e) => this.log.warn(`Doctor decision not saved: ${(e as Error).message}`));
    if (choice === 'SEND_TIMES') {
      await this.funnel.record(clinicId, { channel, chatId, kind: 'TIME_OFFERED', refKey: `draft:${id}`, linked: !!ch?.patientId });
      // The times are now really offered: the dialogue remembers WHICH message offered them (a time is accepted only from it)
      if (mid) await this.flow.bindOffer(clinicId, channel, chatId, snap.serviceTitle, mid).catch((e) => this.log.warn(`Offer not remembered: ${(e as Error).message}`));
    }
    if (choice === 'HAND_OFF' && row.requestId) await this.funnel.record(clinicId, { channel, chatId, kind: 'HANDED_OFF', refKey: row.requestId, reason: snap.handoffReason ?? 'other', linked: !!ch?.patientId });
  }

  // ---- the agent's autonomous mode: the same execution, without the button ----

  // The right to act, read again right before a send and before a visit: the permission (switches, the list of dialogs, the autonomous set of services), the
  // owner of the dialogue, an unfinished action of this chat and the service of the request. null: it may act.
  private async autoRight(row: AgentDraftRow, snap: Snapshot, choice: Choice): Promise<string | null> {
    const { clinicId, channel, chatId } = row;
    if (await this.gate.denied(clinicId, channel, chatId)) return 'permission';
    const state = await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } }, select: { owner: true } });
    if (state?.owner === 'HUMAN') return 'owner_human';
    await this.settleStuck(clinicId, channel, chatId);
    const open = await this.prisma.agentDraft.findFirst({ where: { clinicId, channel, chatId, id: { not: row.id }, status: { in: ['APPROVING', 'UNKNOWN'] } }, select: { id: true } });
    if (open) return 'unfinished_action';
    // the clinic's autonomous set as it is NOW (a service removed from it, made inactive or unapproved since the draft was made stops the action here)
    const allowed = await this.gate.testServices(clinicId);
    if (!allowed.length) return 'no_test_service';
    if (snap.step) {
      const req = await this.prisma.bookingRequest.findFirst({ where: { id: snap.step.requestId, clinicId }, select: { service: true, autoState: true } });
      if (!req || !allowed.some((x) => x.title === req.service)) return 'other_service';
      if (req.autoState === 'UNKNOWN' || req.autoState === 'RUNNING') return 'unfinished_action';
    } else if (choice === 'SEND_TIMES' && !allowed.some((x) => x.id === snap.exec.serviceId)) return 'other_service';
    return null;
  }

  // The next booking step as a stored draft, ready to be executed (for the autonomous mode): the same step the screen would show. Null when there is none, or
  // when that step was already made for this state (sent, rejected, being done, unknown).
  async stageStep(clinicId: string, channel: string, chatId: string, resume?: string): Promise<{ id: string; revision: number; choice: Choice } | { note: AgentNote; detail?: string } | null> {
    const req = await this.requests.openFor(clinicId, channel, chatId);
    if (!req || req.kind !== 'BOOKING' || req.confirmedAt) return null;
    const plan = await this.flow.agentPlan(clinicId, req.id, resume);
    if (plan.step === 'NONE') return null;
    if (plan.step === 'NOTE') return { note: plan.note, ...(plan.detail ? { detail: plan.detail } : {}) };
    const where = { clinicId, channel, chatId, AND: [{ snapshot: { path: ['step', 'requestId'], equals: plan.requestId } }, { snapshot: { path: ['step', 'key'], equals: plan.key } }, ...(resume ? [{ snapshot: { path: ['step', 'resume'], equals: resume } }] : [])] };
    const seen = await this.prisma.agentDraft.findFirst({ where: { ...where, status: { notIn: ['SUPERSEDED', 'FAILED'] } }, orderBy: { createdAt: 'desc' } });
    if (seen) return seen.status === 'PENDING' ? { id: seen.id, revision: seen.revision, choice: (seen.snapshot as unknown as Snapshot).allowed[0] } : null;
    const snapshot = this.stepSnapshot(plan, resume);
    const last = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, NOT: { direction: 'OUT', error: { not: null } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true } });
    const state = await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } }, select: { version: true, owner: true } });
    await this.prisma.agentDraft.updateMany({ where: { clinicId, channel, chatId, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
    const row = await this.prisma.agentDraft.create({ data: { clinicId, channel, chatId, basisMessageId: last?.id ?? '', basisAt: last?.createdAt ?? new Date(), stateVersion: state?.version ?? 0, basisOwner: state?.owner ?? 'BOT', createdById: null, requestId: plan.requestId, snapshot: snapshot as unknown as Prisma.InputJsonValue } });
    return { id: row.id, revision: row.revision, choice: snapshot.allowed[0] };
  }

  // A short answer written by the CODE (not the model), stored as a draft so that it is sent by the same execution as every other message (the checks, the
  // transport confirmation, the protection against a lost result). Used for the answers after a finished booking and for the notice of a hand-over.
  async stageReply(clinicId: string, channel: string, chatId: string, text: string): Promise<{ id: string; revision: number }> {
    const snapshot: Snapshot = { status: 'READY', reply: text, action: 'NONE', proposed: 'NONE', contentKind: 'ANSWER', options: [], serviceTitle: null, handoffReason: null, checkRejected: null, exec: { serviceId: null, prices: [], pref: null, lang: 'uk', handoffText: '' }, allowed: ['SEND_REPLY'], unsupported: false };
    const last = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, NOT: { direction: 'OUT', error: { not: null } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true } });
    const state = await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } }, select: { version: true, owner: true } });
    await this.prisma.agentDraft.updateMany({ where: { clinicId, channel, chatId, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
    const row = await this.prisma.agentDraft.create({ data: { clinicId, channel, chatId, basisMessageId: last?.id ?? '', basisAt: last?.createdAt ?? new Date(), stateVersion: state?.version ?? 0, basisOwner: state?.owner ?? 'BOT', createdById: null, snapshot: snapshot as unknown as Prisma.InputJsonValue } });
    return { id: row.id, revision: row.revision };
  }

  // The chosen time was found taken (nothing was created): the code itself offers FRESH times for the same service, or, when there are none in the searched range, asks whether the request
  // should go to the administrator (an offer, never "done"). The contact data already given stay on the open request; the time that was taken was offered before, so it is not offered again.
  // The message is stored as a draft and sent by the same execution as every other one (the checks, the transport confirmation). null: the service is not known.
  async stageSlotGone(clinicId: string, channel: string, chatId: string): Promise<{ id: string; revision: number; choice: Choice } | null> {
    const state = await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } }, select: { version: true, owner: true, serviceId: true } });
    const req = await this.requests.openFor(clinicId, channel, chatId);
    const serviceId = state?.serviceId ?? (req?.service ? (await this.prisma.kbItem.findFirst({ where: { clinicId, kind: 'SERVICE', title: req.service, active: true }, select: { id: true } }))?.id ?? null : null);
    if (!serviceId) return null;
    const lang = await conversationLanguage(this.prisma, clinicId, channel, chatId);
    // doctors mode: only the times of the request's own doctor (never another one without the patient's yes)
    const doctorIds = req?.doctorId && req.scheduleMode === 'DOCTORS' ? [req.doctorId] : undefined;
    // (doctors mode: the wish of the offer that was really sent last still holds for the replacement times)
    const sentPref = doctorIds ? ((await this.prisma.agentDraft.findFirst({ where: { clinicId, channel, chatId, status: 'SENT', choice: 'SEND_TIMES' }, orderBy: { createdAt: 'desc' }, select: { snapshot: true } }))?.snapshot as unknown as Snapshot | undefined)?.exec.pref ?? null : null;
    const fresh = await this.agent.refreshOptions(clinicId, channel, chatId, { serviceId, pref: sentPref, doctorIds, lang });
    const text = fresh.options.length
      ? lang === 'ru' ? 'К сожалению, это время уже занято. Выберите, пожалуйста, другое удобное время из предложенных ниже.' : 'На жаль, цей час уже зайнятий. Оберіть, будь ласка, інший зручний час із запропонованих нижче.'
      : lang === 'ru' ? 'К сожалению, это время уже занято, а других свободных окон на ближайшие 7 дней не нашлось. Передать ваш запрос администратору, чтобы он подобрал время?' : 'На жаль, цей час уже зайнятий, а інших вільних вікон на найближчі 7 днів не знайшлося. Передати ваш запит адміністратору, щоб він підібрав час?';
    const options = fresh.options.map((o) => ({ label: o.label, date: o.date, time: o.time, ...(o.doctorId ? { doctorId: o.doctorId } : {}) }));
    const snapshot: Snapshot = { status: 'READY', reply: text, action: options.length ? 'OFFER_TIME' : 'NONE', proposed: options.length ? 'OFFER_TIME' : 'NONE', contentKind: 'ANSWER', options, serviceTitle: req?.service ?? null, handoffReason: null, checkRejected: null, exec: { serviceId, prices: [], pref: sentPref, lang, handoffText: '', ...(doctorIds ? { doctorIds } : {}) }, allowed: [options.length ? 'SEND_TIMES' : 'SEND_REPLY'], unsupported: false };
    const last = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, NOT: { direction: 'OUT', error: { not: null } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true } });
    await this.prisma.agentDraft.updateMany({ where: { clinicId, channel, chatId, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
    const row = await this.prisma.agentDraft.create({ data: { clinicId, channel, chatId, basisMessageId: last?.id ?? '', basisAt: last?.createdAt ?? new Date(), stateVersion: state?.version ?? 0, basisOwner: state?.owner ?? 'BOT', createdById: null, snapshot: snapshot as unknown as Prisma.InputJsonValue } });
    return { id: row.id, revision: row.revision, choice: snapshot.allowed[0] };
  }

  // What the autonomous mode may execute of a model draft: the answer, the times of the one test service, the hand-over (a safe fallback hands over). Anything
  // else (an unsupported action) is left for a person.
  autoChoice(view: DraftView): Choice | null {
    if (view.unsupported) return null;
    if (view.kind === 'handoff' || view.kind === 'fallback') return view.allowed.includes('HAND_OFF') ? 'HAND_OFF' : null;
    if (view.kind === 'times') return view.allowed.includes('SEND_TIMES') ? 'SEND_TIMES' : null;
    return view.allowed.includes('SEND_REPLY') ? 'SEND_REPLY' : null;
  }

  async settle(clinicId: string, channel: string, chatId: string) {
    await this.settleStuck(clinicId, channel, chatId);
  }

  // ---- cancelling a visit this dialogue created (the autonomous mode; the first slice) ----

  // The visits that may be cancelled here: only those the dialogue's own confirmed booking request created (BookingRequest → externalVisitId), still ahead
  cancelTargets(clinicId: string, channel: string, chatId: string): Promise<ConversationVisit[]> {
    return conversationVisits(this.prisma, clinicId, channel, chatId);
  }

  // The same keys as a booking write: the clinic's flag, the server's write switches, and the live-test restriction of dialogs
  async cancelWritable(clinicId: string, channel: string, chatId: string): Promise<boolean> {
    return (await this.booking.status(clinicId)).enabled && this.autoBooking.allowed(clinicId, { channel, chatId });
  }

  // The question "cancel this visit?" with its own two buttons (never the buttons of the booking); the buttons carry the question's id, so an answer is tied to
  // this question and to the visit as it was when it was asked
  async stageCancelQuestion(clinicId: string, channel: string, chatId: string, v: ConversationVisit, lang: 'uk' | 'ru', repeat = false): Promise<{ id: string; revision: number; choice: Choice }> {
    const id = randomUUID().replace(/-/g, '');
    const ref = cancelRefOf(v);
    const T = CANCEL_TEXT[lang];
    const text = T.ask(ref, repeat);
    const options = [
      { label: T.yes, date: '', time: '', payload: `cancelyes|${id}` },
      { label: T.no, date: '', time: '', payload: `cancelno|${id}` },
    ];
    const snapshot: Snapshot = { status: 'READY', reply: text, action: 'NONE', proposed: null, contentKind: null, options: [], serviceTitle: null, handoffReason: null, checkRejected: null, exec: { serviceId: null, prices: [], pref: null, lang, handoffText: '' }, allowed: ['ASK_CANCEL'], unsupported: false, step: { kind: 'ASK_CANCEL', requestId: v.requestId, key: cancelKeyOf(v), text, options, cancel: ref } };
    const row = await this.newStepDraft(clinicId, channel, chatId, v.requestId, snapshot, id);
    return { id: row.id, revision: row.revision, choice: 'ASK_CANCEL' };
  }

  // The cancellation question that is open NOW: the last question really sent, and our last message in the dialogue (anything sent after it closes it)
  async pendingCancelQuestion(clinicId: string, channel: string, chatId: string): Promise<{ id: string; requestId: string; key: string; cancel: CancelRef } | null> {
    const p = await this.pendingChange(clinicId, channel, chatId);
    return p?.kind === 'ASK_CANCEL' && p.step.cancel ? { id: p.id, requestId: p.step.requestId, key: p.step.key, cancel: p.step.cancel } : null;
  }

  // The question about an existing visit (cancel or move) that is open NOW: our last message in the dialogue is that question, really sent
  async pendingChange(clinicId: string, channel: string, chatId: string): Promise<{ id: string; kind: string; step: NonNullable<Snapshot['step']> } | null> {
    const lastOut = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'OUT', error: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    if (!lastOut) return null;
    const ask = await this.prisma.agentDraft.findFirst({ where: { clinicId, channel, chatId, status: 'SENT', messageId: lastOut.id, choice: { in: ['ASK_CANCEL', 'ASK_MOVE_TIME', 'OFFER_MOVE', 'ASK_MOVE'] } } });
    const st = (ask?.snapshot as unknown as Snapshot | undefined)?.step;
    return ask && st ? { id: ask.id, kind: st.kind, step: st } : null;
  }

  // The cancellation after the patient's "yes" to THAT question. Made once per question: null when it was already made (done, being done, unknown or refused by
  // Cliniccards); a repeated "yes" never writes again.
  async stageCancelVisit(clinicId: string, channel: string, chatId: string, askId: string): Promise<{ id: string; revision: number; choice: Choice } | null> {
    const ask = await this.pendingCancelQuestion(clinicId, channel, chatId);
    if (!ask || ask.id !== askId) return null;
    const seen = await this.prisma.agentDraft.findFirst({ where: { clinicId, channel, chatId, status: { not: 'SUPERSEDED' }, snapshot: { path: ['step', 'askId'], equals: askId } }, select: { id: true } });
    if (seen) return null;
    const snapshot: Snapshot = { status: 'READY', reply: '', action: 'NONE', proposed: null, contentKind: null, options: [], serviceTitle: null, handoffReason: null, checkRejected: null, exec: { serviceId: null, prices: [], pref: null, lang: 'uk', handoffText: '' }, allowed: ['CANCEL_VISIT'], unsupported: false, step: { kind: 'CANCEL_VISIT', requestId: ask.requestId, key: ask.key, cancel: ask.cancel, askId } };
    const row = await this.newStepDraft(clinicId, channel, chatId, ask.requestId, snapshot);
    return { id: row.id, revision: row.revision, choice: 'CANCEL_VISIT' };
  }

  // ---- moving a visit this dialogue created (the same visit, service, doctor and length) ----

  // "on which day and at what time?" (asked when the patient's words gave no wish)
  async stageMoveTimeQuestion(clinicId: string, channel: string, chatId: string, v: ConversationVisit, lang: 'uk' | 'ru'): Promise<{ id: string; revision: number; choice: Choice }> {
    const ref = cancelRefOf(v);
    const text = MOVE_TEXT[lang].askTime(ref);
    const snapshot = this.changeSnapshot('ASK_MOVE_TIME', lang, text, { kind: 'ASK_MOVE_TIME', requestId: v.requestId, key: cancelKeyOf(v), text, options: [], visit: ref });
    const row = await this.newStepDraft(clinicId, channel, chatId, v.requestId, snapshot);
    return { id: row.id, revision: row.revision, choice: 'ASK_MOVE_TIME' };
  }

  // The new times for the SAME visit, found by the same search and wish logic as a booking (doctors mode: that doctor only; cabinets mode: the service's
  // cabinets). The visit's own time is not offered. null: no free time for the wish in the searched range.
  async stageMoveOffer(clinicId: string, channel: string, chatId: string, v: ConversationVisit, lang: 'uk' | 'ru', pref: TimePreference | null, gone = false): Promise<{ id: string; revision: number; choice: Choice } | null> {
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { scheduleMode: true } });
    const svc = v.service ? await this.prisma.kbItem.findFirst({ where: { clinicId, kind: 'SERVICE', title: v.service, active: true }, select: { id: true } }) : null;
    if (!svc) return null;
    const fresh = await this.agent.refreshOptions(clinicId, channel, chatId, { serviceId: svc.id, pref, lang, ...(clinic.scheduleMode === 'DOCTORS' && v.doctorId ? { doctorIds: [v.doctorId] } : {}) });
    const own = `${clinicDate(v.startsAt)}|${clinicHm(v.startsAt)}`;
    const id = randomUUID().replace(/-/g, '');
    const options = fresh.options.filter((o) => `${o.date}|${o.time}` !== own && (!o.doctorId || o.doctorId === v.doctorId)).map((o) => ({ label: o.label, date: '', time: '', payload: `moveslot|${id}|${o.date}|${o.time}` }));
    if (!options.length) return null;
    const ref = cancelRefOf(v);
    const text = MOVE_TEXT[lang].offer(ref, gone);
    const snapshot = this.changeSnapshot('OFFER_MOVE', lang, text, { kind: 'OFFER_MOVE', requestId: v.requestId, key: cancelKeyOf(v), text, options, visit: ref });
    const row = await this.newStepDraft(clinicId, channel, chatId, v.requestId, snapshot, id);
    return { id: row.id, revision: row.revision, choice: 'OFFER_MOVE' };
  }

  // The confirmation "now → new time" for one time of the offer that is open now. The time is checked first (read only: the doctor's hours, the service, a free
  // cabinet, the visit itself left out); 'gone' when it is no longer free, 'stale' when the offer is not the open one or the time was not on it.
  async stageMoveConfirm(clinicId: string, channel: string, chatId: string, v: ConversationVisit, offerId: string, date: string, time: string, lang: 'uk' | 'ru', repeat?: MoveTo): Promise<{ id: string; revision: number; choice: Choice } | 'gone' | 'stale' | { note: string }> {
    let to = repeat;
    if (!to) {
      const p = await this.pendingChange(clinicId, channel, chatId);
      if (!p || p.id !== offerId || p.kind !== 'OFFER_MOVE' || !(p.step.options ?? []).some((o) => o.payload === `moveslot|${offerId}|${date}|${time}`)) return 'stale';
      const startsAt = localToUtc(`${date} ${time}:00`);
      const place = await this.flow.movePlacement(clinicId, { externalId: v.externalVisitId, doctorId: v.doctorId, service: v.service, minutes: v.minutes }, startsAt);
      if (!place.ok) return place.busy ? 'gone' : { note: place.note };
      to = { startsAt: startsAt.toISOString(), cabinetId: place.cabinetId, date: `${date.slice(8)}.${date.slice(5, 7)}.${date.slice(0, 4)}`, time };
    }
    const id = randomUUID().replace(/-/g, '');
    const T = MOVE_TEXT[lang];
    const ref = cancelRefOf(v);
    const text = T.confirm(ref, to, !!repeat);
    const options = [
      { label: T.yes, date: '', time: '', payload: `moveyes|${id}` },
      { label: T.no, date: '', time: '', payload: `moveno|${id}` },
    ];
    const snapshot = this.changeSnapshot('ASK_MOVE', lang, text, { kind: 'ASK_MOVE', requestId: v.requestId, key: cancelKeyOf(v), text, options, visit: ref, to });
    const row = await this.newStepDraft(clinicId, channel, chatId, v.requestId, snapshot, id);
    return { id: row.id, revision: row.revision, choice: 'ASK_MOVE' };
  }

  // The move after the patient's "yes" to THAT confirmation; made once per confirmation (null: already made, being made, unknown or refused by Cliniccards)
  async stageMoveVisit(clinicId: string, channel: string, chatId: string, askId: string): Promise<{ id: string; revision: number; choice: Choice } | null> {
    const p = await this.pendingChange(clinicId, channel, chatId);
    if (!p || p.id !== askId || p.kind !== 'ASK_MOVE' || !p.step.visit || !p.step.to) return null;
    const seen = await this.prisma.agentDraft.findFirst({ where: { clinicId, channel, chatId, status: { not: 'SUPERSEDED' }, snapshot: { path: ['step', 'askId'], equals: askId } }, select: { id: true } });
    if (seen) return null;
    const snapshot = this.changeSnapshot('MOVE_VISIT', 'uk', '', { kind: 'MOVE_VISIT', requestId: p.step.requestId, key: p.step.key, visit: p.step.visit, to: p.step.to, askId });
    const row = await this.newStepDraft(clinicId, channel, chatId, p.step.requestId, snapshot);
    return { id: row.id, revision: row.revision, choice: 'MOVE_VISIT' };
  }

  private changeSnapshot(choice: Choice, lang: 'uk' | 'ru', reply: string, step: NonNullable<Snapshot['step']>): Snapshot {
    return { status: 'READY', reply, action: 'NONE', proposed: null, contentKind: null, options: [], serviceTitle: null, handoffReason: null, checkRejected: null, exec: { serviceId: null, prices: [], pref: null, lang, handoffText: '' }, allowed: [choice], unsupported: false, step };
  }

  // The write: BookingService.reschedule moves the same visit (fresh reading of the visit, the schedule rules again with only this visit left out, the place free,
  // one attempt key per visit and time, reconciliation of a lost answer). SENT: moved; the message about it is a separate step of the caller.
  private async moveVisit(row: AgentDraftRow, snap: Snapshot): Promise<ApprovalResult> {
    const st = snap.step!;
    const v = st.visit!;
    const to = st.to!;
    const set = (data: Prisma.AgentDraftUncheckedUpdateManyInput) => this.prisma.agentDraft.updateMany({ where: { id: row.id, status: 'APPROVING' }, data: { ...data, requestId: st.requestId } });
    const own = await this.prisma.visit.findFirst({ where: { id: v.visitId, clinicId: row.clinicId }, select: { startsAt: true, endsAt: true } });
    const minutes = own ? Math.round(((own.endsAt ?? new Date(own.startsAt.getTime() + 30 * 60_000)).getTime() - own.startsAt.getTime()) / 60_000) : 30;
    try {
      const r = await this.booking.reschedule(row.clinicId, null, v.visitId, {
        startsAt: new Date(to.startsAt),
        cabinetId: to.cabinetId,
        // the operation is the patient's confirmation: its retries reuse one attempt, another confirmation (even to the same time) is another move
        operationId: st.askId,
        origin: { channel: row.channel, chatId: row.chatId },
        expect: { externalId: v.externalVisitId, startsAt: new Date(v.startsAt), doctorId: v.doctorId },
        verify: async () => {
          const p = await this.flow.movePlacement(row.clinicId, { externalId: v.externalVisitId, doctorId: v.doctorId, service: v.service, minutes }, new Date(to.startsAt));
          if (!p.ok) throw p.busy ? new ConflictException('booking_slot_taken') : new BadRequestException(`move_not_possible: ${p.note}`);
        },
      });
      await set({ status: 'SENT', error: null });
      return { ok: true, outcome: 'SENT', ...(r.duplicate ? { already: true } : {}), booking: { visit: r.externalVisitId, notice: null, requestId: st.requestId }, draft: null };
    } catch (e) {
      const res = e instanceof HttpException ? e.getResponse() : null;
      const code = String(typeof res === 'string' ? res : ((res as { message?: unknown } | null)?.message as string | undefined) ?? (e as Error).message);
      if (code === 'booking_unknown') {
        await set({ status: 'UNKNOWN', error: 'move_unknown' });
        return { ok: false, outcome: 'UNKNOWN', reasons: [code], draft: null };
      }
      if (code === 'booking_failed') {
        await set({ status: 'FAILED', error: code });
        return { ok: false, outcome: 'FAILED', reasons: [code], draft: null };
      }
      await set({ status: 'SUPERSEDED', error: code.slice(0, 200) });
      const busy = ['booking_slot_taken', 'booking_slot_blocked', 'booking_patient_busy'].includes(code);
      return { ok: false, outcome: 'REFUSED', code: code === 'booking_in_progress' ? 'in_progress' : busy ? 'slot_unavailable' : code === 'visit_changed' || code === 'visit_not_changeable' ? 'visit_changed' : 'not_possible', reasons: [code], draft: null };
    }
  }

  private async newStepDraft(clinicId: string, channel: string, chatId: string, requestId: string, snapshot: Snapshot, id?: string) {
    const last = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, NOT: { direction: 'OUT', error: { not: null } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true } });
    const state = await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } }, select: { version: true, owner: true } });
    await this.prisma.agentDraft.updateMany({ where: { clinicId, channel, chatId, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
    return this.prisma.agentDraft.create({ data: { ...(id ? { id } : {}), clinicId, channel, chatId, basisMessageId: last?.id ?? '', basisAt: last?.createdAt ?? new Date(), stateVersion: state?.version ?? 0, basisOwner: state?.owner ?? 'BOT', createdById: null, requestId, snapshot: snapshot as unknown as Prisma.InputJsonValue } });
  }

  // The write itself, through BookingService.cancel (fresh reading of Cliniccards before the PUT, one attempt key per visit, reconciliation of a lost answer).
  // SENT: the visit is cancelled (or was already cancelled in Cliniccards); the message about it is a separate step of the caller.
  private async cancelVisit(row: AgentDraftRow, snap: Snapshot): Promise<ApprovalResult> {
    const st = snap.step!;
    const c = st.cancel!;
    const set = (data: Prisma.AgentDraftUncheckedUpdateManyInput) => this.prisma.agentDraft.updateMany({ where: { id: row.id, status: 'APPROVING' }, data: { ...data, requestId: st.requestId } });
    try {
      const r = await this.booking.cancel(row.clinicId, null, c.visitId, { origin: { channel: row.channel, chatId: row.chatId }, expect: { externalId: c.externalVisitId, startsAt: new Date(c.startsAt), doctorId: c.doctorId } });
      await set({ status: 'SENT', error: null });
      return { ok: true, outcome: 'SENT', ...(r.duplicate ? { already: true } : {}), booking: { visit: r.externalVisitId, notice: null, requestId: st.requestId }, draft: null };
    } catch (e) {
      const res = e instanceof HttpException ? e.getResponse() : null;
      const code = typeof res === 'string' ? res : ((res as { message?: unknown } | null)?.message as string | undefined) ?? (e as Error).message;
      // the answer of Cliniccards was lost and could not be checked: neither "cancelled" nor "still booked"; nothing is tried again by itself
      if (code === 'booking_unknown') {
        await set({ status: 'UNKNOWN', error: 'cancel_unknown' });
        return { ok: false, outcome: 'UNKNOWN', reasons: [code], draft: null };
      }
      // Cliniccards refused the write: nothing changed
      if (code === 'booking_failed') {
        await set({ status: 'FAILED', error: code });
        return { ok: false, outcome: 'FAILED', reasons: [code], draft: null };
      }
      // refused before any write: the visit changed or cannot be read, writing is off, the dialog is not allowed, another attempt is running
      await set({ status: 'SUPERSEDED', error: String(code).slice(0, 200) });
      return { ok: false, outcome: 'REFUSED', code: code === 'booking_in_progress' ? 'in_progress' : code === 'visit_changed' || code === 'visit_not_changeable' ? 'visit_changed' : 'not_possible', reasons: [String(code)], draft: null };
    }
  }

  // ---- the booking steps (after the patient chose a time) ----

  // Makes the next step of the booking for this dialogue, when there is one and nothing else is waiting. Nothing is sent or created: it is only offered to staff.
  private async ensureStep(clinicId: string, channel: string, chatId: string): Promise<void> {
    if (!(await this.flow.agentMode(clinicId))) return;
    const req = await this.requests.openFor(clinicId, channel, chatId);
    if (!req || req.kind !== 'BOOKING' || req.confirmedAt) return;
    // a draft a staff member asked for after the last change of the request is theirs: the step does not push it away
    // a visit whose result is not known (or that is being made) is never covered by a new step: it is checked first
    const inFlight = await this.prisma.agentDraft.findFirst({ where: { clinicId, channel, chatId, status: { in: ['APPROVING', 'UNKNOWN'] }, snapshot: { path: ['step', 'requestId'], equals: req.id } }, select: { id: true } });
    if (inFlight) return;
    const waiting = await this.prisma.agentDraft.findFirst({ where: { clinicId, channel, chatId, status: { in: ['PENDING', 'APPROVING', 'UNKNOWN'] }, createdAt: { gte: req.updatedAt } }, select: { id: true } });
    if (waiting) return;
    // The plan reads the clinic's system (is the place still free): the same state of the request is not evaluated again within a minute (the screen polls)
    const stateKey = `${req.id}|${this.flow.agentKeyOf(req)}`;
    const checked = this.evaluated.get(stateKey);
    if (checked && Date.now() - checked < EVAL_MS) return;
    this.evaluated.set(stateKey, Date.now());
    if (this.evaluated.size > 500) this.evaluated.clear();
    const plan = await this.flow.agentPlan(clinicId, req.id);
    if (plan.step === 'NONE') return;
    // the same step for the same state is made once (not again after it was sent, rejected or is waiting); a failed one may be made again
    const seen = await this.prisma.agentDraft.findFirst({
      where: { clinicId, channel, chatId, status: { notIn: ['SUPERSEDED', 'FAILED'] }, AND: [{ snapshot: { path: ['step', 'requestId'], equals: plan.requestId } }, { snapshot: { path: ['step', 'key'], equals: plan.key } }] },
      select: { id: true },
    });
    if (seen) return;
    const snapshot = this.stepSnapshot(plan);
    const last = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, NOT: { direction: 'OUT', error: { not: null } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true } });
    const state = await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } }, select: { version: true, owner: true } });
    await this.prisma.agentDraft.updateMany({ where: { clinicId, channel, chatId, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
    await this.prisma.agentDraft.create({ data: { clinicId, channel, chatId, basisMessageId: last?.id ?? '', basisAt: last?.createdAt ?? new Date(), stateVersion: state?.version ?? 0, basisOwner: state?.owner ?? 'BOT', createdById: null, requestId: plan.requestId, snapshot: snapshot as unknown as Prisma.InputJsonValue } });
  }

  private stepSnapshot(plan: Exclude<Awaited<ReturnType<BookingFlowService['agentPlan']>>, { step: 'NONE' }>, resume?: string): Snapshot {
    const exec: DraftExec = { serviceId: null, prices: [], pref: null, lang: 'uk', handoffText: '' };
    const base = { status: 'READY' as const, action: 'NONE', proposed: null, contentKind: null, options: [], serviceTitle: null, handoffReason: null, checkRejected: null, exec, unsupported: false };
    if (plan.step === 'NOTE') return { ...base, reply: '', allowed: [], step: { kind: 'NOTE', requestId: plan.requestId, key: plan.key, note: plan.note, ...(plan.detail ? { detail: plan.detail } : {}) } };
    const withResume = (x: Snapshot): Snapshot => (resume && x.step ? { ...x, step: { ...x.step, resume } } : x);
    if (plan.step === 'ASK_DATA') return withResume({ ...base, reply: plan.text, allowed: ['ASK_DATA'], step: { kind: 'ASK_DATA', requestId: plan.requestId, key: plan.key, text: plan.text, field: plan.field, asks: plan.asks } });
    if (plan.step === 'ASK_CONSENT') return withResume({ ...base, reply: plan.text, allowed: ['ASK_CONSENT'], step: { kind: 'ASK_CONSENT', requestId: plan.requestId, key: plan.key, consentKey: plan.consentKey, text: plan.text, options: plan.options.map((o) => ({ label: o.label, date: o.date, time: o.time, ...(o.payload ? { payload: o.payload } : {}) })), summary: plan.summary } });
    return { ...base, reply: plan.summary.preview, allowed: ['CREATE_VISIT'], step: { kind: 'CREATE_VISIT', requestId: plan.requestId, key: plan.key, consentKey: plan.consentKey, summary: plan.summary } };
  }

  // The step is made again for the state the request is in now (a staff member pressed "refresh")
  async refresh(clinicId: string, channel: string, chatId: string): Promise<DraftView | null> {
    this.evaluated.clear();
    const pending = await this.prisma.agentDraft.findMany({ where: { clinicId, channel, chatId, status: 'PENDING' } });
    for (const d of pending) if ((d.snapshot as unknown as Snapshot).step) await this.prisma.agentDraft.updateMany({ where: { id: d.id, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
    return this.latest(clinicId, channel, chatId);
  }

  // Is the step still what the request needs (the checks that read other systems are made by the plan)
  private async stepFresh(row: AgentDraftRow, snap: Snapshot): Promise<{ refuse?: RefusalCode; reasons?: string[]; fresh?: AgentDraftRow }> {
    const st = snap.step!;
    if (st.kind === 'NOTE') return { refuse: 'not_allowed' };
    if (CANCEL_STEPS.includes(st.kind)) {
      // the visit is still the one the question named (our copy: time, doctor, status), and a change may be written at all
      const ref = st.cancel ?? st.visit;
      const v = (await conversationVisits(this.prisma, row.clinicId, row.channel, row.chatId)).find((x) => x.visitId === ref?.visitId);
      if (!v || cancelKeyOf(v) !== st.key) return { refuse: 'visit_changed' };
      if (!(await this.cancelWritable(row.clinicId, row.channel, row.chatId))) return { refuse: 'write_disabled' };
      return {};
    }
    const plan = await this.flow.agentPlan(row.clinicId, st.requestId, st.resume);
    if (plan.step === 'NOTE') return { refuse: plan.note === 'slot_gone' ? 'slot_unavailable' : plan.note === 'identity' ? 'identity_needed' : 'not_possible' };
    if (plan.step !== st.kind || plan.key !== st.key) return { refuse: 'step_changed' };
    if ((plan.step === 'ASK_CONSENT' || plan.step === 'CREATE_VISIT') && plan.consentKey !== st.consentKey) return { refuse: 'consent_changed' };
    return {};
  }

  private async executeStep(row: AgentDraftRow, snap: Snapshot, choice: Choice, userId: string | null, patientId: string | null, auto = false): Promise<ApprovalResult> {
    const st = snap.step!;
    if (choice !== 'CREATE_VISIT' && !WRITE_STEPS.includes(choice)) {
      // a message: the same sending, the same confirmation of the channel and the same protection against a lost result as every other message of the agent
      const options = (st.options ?? []).map((o) => ({ label: o.label, date: o.date, time: o.time, ...(o.payload ? { payload: o.payload } : {}) }));
      const sent = await this.deliver(row.id, row.clinicId, row.channel, row.chatId, st.text ?? '', options, userId, patientId, false);
      const done = (data: Prisma.AgentDraftUncheckedUpdateManyInput) => this.prisma.agentDraft.updateMany({ where: { id: row.id, status: 'APPROVING' }, data: { ...data, requestId: st.requestId } });
      if (sent.kind === 'FAILED') {
        await done({ status: 'FAILED', error: sent.error });
        return { ok: false, outcome: 'FAILED', draft: null };
      }
      if (sent.kind === 'UNKNOWN') {
        await done({ status: 'UNKNOWN', error: sent.error });
        return { ok: false, outcome: 'UNKNOWN', draft: await this.view(await this.prisma.agentDraft.findUniqueOrThrow({ where: { id: row.id } })) };
      }
      await done({ status: 'SENT', messageId: (sent as { messageId: string }).messageId });
      await this.completeSent(await this.prisma.agentDraft.findUniqueOrThrow({ where: { id: row.id } }), (sent as { messageId: string }).messageId);
      return { ok: true, outcome: 'SENT', draft: null };
    }
    return choice === 'CANCEL_VISIT' ? this.cancelVisit(row, snap) : choice === 'MOVE_VISIT' ? this.moveVisit(row, snap) : this.bookVisit(row, snap, userId);
  }

  // The visit itself: after the patient's consent and this explicit action. The result of the VISIT and the delivery of the MESSAGE about it are different things.
  private async bookVisit(row: AgentDraftRow, snap: Snapshot, userId: string | null): Promise<ApprovalResult> {
    const st = snap.step!;
    const res = await this.flow.bookApproved(row.clinicId, userId, st.requestId, st.consentKey ?? '');
    const set = (data: Prisma.AgentDraftUncheckedUpdateManyInput) => this.prisma.agentDraft.updateMany({ where: { id: row.id, status: 'APPROVING' }, data: { ...data, requestId: st.requestId } });
    if (res.kind === 'DONE' || res.kind === 'ALREADY') {
      await set({ status: 'SENT', error: null });
      if (res.kind === 'DONE') await this.rememberStage(row.clinicId, row.channel, row.chatId, 'CLOSED', st.requestId);
      return { ok: true, outcome: 'SENT', ...(res.kind === 'ALREADY' ? { already: true } : {}), ...(res.kind === 'DONE' ? { booking: { visit: res.visit, notice: res.notice, requestId: st.requestId } } : {}), draft: null };
    }
    if (res.kind === 'UNKNOWN') {
      await set({ status: 'UNKNOWN', error: 'booking_unknown' });
      return { ok: false, outcome: 'UNKNOWN', draft: await this.view(await this.prisma.agentDraft.findUniqueOrThrow({ where: { id: row.id } })) };
    }
    if (res.kind === 'FAILED') {
      await set({ status: 'FAILED', error: res.note.slice(0, 200) });
      return { ok: false, outcome: 'FAILED', draft: null };
    }
    // refused: nothing was created; the step is stale (it is made again for the new state) or stays for another try
    const stale = res.code === 'slot_unavailable' || res.code === 'consent_changed' || res.code === 'consent_missing' || res.code === 'identity_needed';
    await this.prisma.agentDraft.updateMany({ where: { id: row.id, status: 'APPROVING' }, data: { status: stale ? 'SUPERSEDED' : 'PENDING', approvedById: null, approvedAt: null, choice: null } });
    const code: RefusalCode = res.code === 'not_open' || res.code === 'in_progress' ? (res.code === 'in_progress' ? 'in_progress' : 'not_active') : res.code;
    return { ok: false, outcome: 'REFUSED', code, draft: stale ? null : await this.view(await this.prisma.agentDraft.findUniqueOrThrow({ where: { id: row.id } })) };
  }

  // After an unknown result of creating the visit: the clinic's system is checked (BookingService.book looks for the visit before it does anything again).
  // Never a blind second write: a visit that is found is recorded, nothing found and nothing unclear lets the ordinary guarded attempt run.
  async recheck(clinicId: string, userId: string, id: string): Promise<ApprovalResult> {
    const row = await this.prisma.agentDraft.findFirst({ where: { id, clinicId } });
    if (!row) throw new NotFoundException('draft_not_found');
    const snap = row.snapshot as unknown as Snapshot;
    if (row.status !== 'UNKNOWN' || snap.step?.kind !== 'CREATE_VISIT') return { ok: false, outcome: 'REFUSED', code: 'not_active', draft: null };
    const claim = await this.prisma.agentDraft.updateMany({ where: { id, status: 'UNKNOWN' }, data: { status: 'APPROVING', approvedById: userId, approvedAt: new Date(), choice: 'CREATE_VISIT' } });
    if (!claim.count) return { ok: false, outcome: 'REFUSED', code: 'in_progress', draft: null };
    return this.bookVisit(row, snap, userId);
  }

  // ---- internals ----

  private async freshness(row: AgentDraftRow, snap: Snapshot, choice: Choice, quick = false, auto = false): Promise<{ refuse?: RefusalCode; reasons?: string[]; fresh?: AgentDraftRow }> {
    const stale = await this.stale(row, auto);
    if (stale.stale) return { refuse: 'stale', reasons: stale.reasons };
    if (auto && (await this.autoRight(row, snap, choice))) return { refuse: 'auto_not_allowed' };
    if (snap.step) return this.stepFresh(row, snap);
    // the services and the prices the text states are the same as now
    if (snap.exec.prices.length) {
      const now = await this.agent.currentPriceStates(row.clinicId);
      for (const p of snap.exec.prices) {
        const cur = now.get(p.serviceId);
        if (!cur || cur.title !== p.title || cur.state !== p.state || cur.amount !== p.amount) return { refuse: 'content_changed' };
      }
    }
    if (choice === 'SEND_TIMES' && !quick) {
      const fresh = await this.agent.refreshOptions(row.clinicId, row.channel, row.chatId, snap.exec);
      if (!fresh.options.length) return { refuse: 'options_unavailable' };
      const key = (o: { date: string; time: string }) => `${o.date}|${o.time}`;
      const same = fresh.options.length === snap.options.length && fresh.options.every((o) => snap.options.some((x) => key(x) === key(o)));
      if (!same) {
        // the changed times are NOT sent: they are stored as a new revision and shown to the staff member again
        const next = { ...snap, options: fresh.options.map((o) => ({ label: o.label, date: o.date, time: o.time, ...(o.doctorId ? { doctorId: o.doctorId } : {}) })) };
        const upd = await this.prisma.agentDraft.updateMany({ where: { id: row.id, status: 'PENDING', revision: row.revision }, data: { snapshot: next as unknown as Prisma.InputJsonValue, revision: { increment: 1 } } });
        const fresher = upd.count ? await this.prisma.agentDraft.findUnique({ where: { id: row.id } }) : null;
        return { refuse: 'options_changed', fresh: fresher ?? undefined };
      }
    }
    return {};
  }

  // Is the draft still the answer to the dialogue as it stands (for a staff member: a human owner of the dialogue is not a reason)
  private async stale(row: AgentDraftRow, auto = false): Promise<{ stale: boolean; reasons: string[] }> {
    const basis: DraftBasis = { lastMessageId: row.basisMessageId, lastMessageAt: row.basisAt.toISOString(), stateVersion: row.stateVersion, owner: row.basisOwner as 'BOT' | 'HUMAN', capturedAt: row.createdAt.toISOString() };
    const s = await this.agent.staleness(row.clinicId, row.channel, row.chatId, basis);
    // a staff member taking the dialogue does not forbid THEIR approval; it does stop the autonomous mode
    const reasons = s.reasons.filter((r) => auto || r !== 'staff_took_over');
    // a booking step is made for one state of the request: when the request changed (the patient answered, chose another time) it is stale
    const step = (row.snapshot as unknown as Snapshot).step;
    if (step && !CANCEL_STEPS.includes(step.kind)) {
      const req = await this.prisma.bookingRequest.findFirst({ where: { id: step.requestId, clinicId: row.clinicId }, include: { patient: { select: { fullName: true, phone: true } } } });
      if (!req || this.flow.agentKeyOf(req) !== step.key) reasons.push('state_changed');
    }
    return { stale: reasons.length > 0, reasons: [...new Set(reasons)] };
  }

  private async execute(row: AgentDraftRow, snap: Snapshot, choice: Choice, userId: string | null, patientId: string | null, auto = false): Promise<ApprovalResult> {
    const { clinicId, channel, chatId, id } = row;
    let requestId: string | null = null;
    let text = snap.reply;
    let options: { label: string; date: string; time: string; doctorId?: string; payload?: string }[] = [];
    if (choice === 'SEND_TIMES') options = snap.options;
    // a question about the doctor carries its own buttons ("так"/"ні", the doctors to choose from)
    if (choice === 'SEND_REPLY' && snap.exec.buttons?.length) options = snap.exec.buttons.map((b) => ({ label: b.label, date: '', time: '', payload: b.payload }));
    if (choice === 'HAND_OFF') {
      // the request for the administrator is made BEFORE the message, so the text never promises a hand-over that did not happen
      text = snap.exec.handoffText;
      const lastIn = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { text: true, contactName: true } });
      try {
        // the patient asks to cancel a visit THIS dialogue created: the request is a cancellation with the reference of that visit (the agent did not cancel it)
        const targets = asksToCancel(lastIn?.text ?? '') ? await conversationVisits(this.prisma, clinicId, channel, chatId) : [];
        // a note of the draft for the staff (the wished doctor, for example) goes into the request itself, never to the patient
        const reqRow = targets.length
          ? await this.requests.upsert(clinicId, { channel, chatId, patientId, contactName: lastIn?.contactName ?? null, kind: 'CANCEL', summary: cancelStaffNote(targets.map((t) => ({ requestId: t.requestId, ref: cancelRefOf(t) })), 'передано з чернетки ШІ') })
          : await this.requests.upsert(clinicId, { channel, chatId, patientId, contactName: lastIn?.contactName ?? null, kind: 'HANDOFF', summary: `Питання передано адміністратору з чернетки ШІ: «${(lastIn?.text ?? '').slice(0, 200)}»${snap.exec.staffNote ? `; ${snap.exec.staffNote}` : ''}` });
        requestId = reqRow.id;
      } catch (e) {
        // the request was not made: "handed over" is NOT said, nothing is sent, the dialogue is not sold to any more by itself (a person must look at it)
        this.log.warn(`Hand-over request not made: ${(e as Error).message}`);
        await this.prisma.agentDraft.updateMany({ where: { id, status: 'APPROVING' }, data: { status: 'FAILED', error: 'handoff_request_failed' } });
        if (auto) await this.prisma.conversationState.upsert({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } }, create: { clinicId, channel, chatId, owner: 'HUMAN' }, update: { owner: 'HUMAN' } });
        return { ok: false, outcome: 'FAILED', draft: null };
      }
    }
    const sent = await this.deliver(id, clinicId, channel, chatId, text, options, userId, patientId, auto);
    const done = (data: Prisma.AgentDraftUncheckedUpdateManyInput) => this.prisma.agentDraft.updateMany({ where: { id, status: 'APPROVING' }, data: { ...data, requestId } });
    if (sent.kind === 'FAILED') {
      await done({ status: 'FAILED', error: sent.error });
      return { ok: false, outcome: 'FAILED', draft: null };
    }
    if (sent.kind === 'UNKNOWN') {
      // not sent again, not shown as a success; no state is changed and no event is written
      await done({ status: 'UNKNOWN', error: sent.error });
      return { ok: false, outcome: 'UNKNOWN', draft: await this.view((await this.prisma.agentDraft.findUniqueOrThrow({ where: { id } }))) };
    }
    const messageId = (sent as { kind: 'SENT'; messageId: string }).messageId;
    await done({ status: 'SENT', messageId });
    const saved = await this.prisma.agentDraft.findUniqueOrThrow({ where: { id } });
    await this.completeSent(saved, messageId);
    return { ok: true, outcome: 'SENT', draft: null };
  }

  // Sends through the existing channel adapters and says what is KNOWN: sent, a clear refusal (nothing was sent), or not known (no clear answer: it may have been sent)
  private async deliver(draftId: string, clinicId: string, channel: string, chatId: string, text: string, options: { label: string; date: string; time: string; doctorId?: string; payload?: string }[], userId: string | null, patientId: string | null, byAi = false): Promise<{ kind: 'SENT'; messageId: string } | { kind: 'FAILED' | 'UNKNOWN'; error: string }> {
    const base = { clinicId, channel, chatId, direction: 'OUT', text, authorUserId: userId, patientId, byAi };
    try {
      await this.messenger.send(clinicId, channel, chatId, text, options);
    } catch (e) {
      if (e instanceof SendError && !e.ambiguous) {
        if (e.blocked && e.reason !== 'window_closed') await this.prisma.patientChannel.updateMany({ where: { clinicId, channel, externalId: chatId }, data: { optedOutAt: new Date() } });
        const error = e.reason === 'not_connected' ? 'not_connected' : e.reason === 'window_closed' ? 'window_closed' : e.message.slice(0, 200);
        await this.prisma.chatMessage.create({ data: { ...base, error } });
        return { kind: 'FAILED', error };
      }
      await this.prisma.chatMessage.create({ data: { ...base, error: 'result_unknown' } }).catch(() => undefined);
      return { kind: 'UNKNOWN', error: 'result_unknown' };
    }
    // The channel accepted the message. This is written FIRST and on its own: it is the only proof, after a stop, that this attempt was sent
    await this.prisma.agentDraft.updateMany({ where: { id: draftId, status: 'APPROVING' }, data: { transportConfirmedAt: new Date() } });
    const msg = await this.prisma.chatMessage.create({ data: { ...base, ...(options.length ? { buttons: options.map((o) => ({ label: o.label, payload: slotPayload(o) })) } : {}) } });
    return { kind: 'SENT', messageId: msg.id };
  }

  // The memory of the agent about the dialogue, written only after a real, successful action: the chosen service, a clarifying question asked, the stage.
  // The shown times are kept in the message itself (its buttons). The owner of the dialogue is never changed here: a staff approval does not give the dialogue back to the bot.
  private async remember(clinicId: string, channel: string, chatId: string, snap: Snapshot, choice: Choice, messageId: string) {
    const stage = choice === 'SEND_TIMES' ? 'OFFERED' : choice === 'HAND_OFF' ? 'HANDED' : snap.action === 'CLOSE' ? 'DECLINED' : 'DISCOVERY';
    const asked = choice === 'SEND_REPLY' && snap.contentKind === 'CLARIFY' ? 1 : 0;
    const where = { clinicId_channel_chatId: { clinicId, channel, chatId } };
    await this.prisma.conversationState.upsert({
      where,
      create: { clinicId, channel, chatId, salesStage: stage, serviceId: snap.exec.serviceId, clarifyCount: asked, lastDecisionMessageId: messageId, version: 1 },
      update: { salesStage: stage, ...(snap.exec.serviceId ? { serviceId: snap.exec.serviceId } : {}), ...(asked ? { clarifyCount: { increment: 1 } } : {}), lastDecisionMessageId: messageId, version: { increment: 1 } },
    });
  }

  // The stage of the dialogue after a booking step that really happened (independent of the analytics switch)
  private async rememberStage(clinicId: string, channel: string, chatId: string, stage: string, requestId: string) {
    const where = { clinicId_channel_chatId: { clinicId, channel, chatId } };
    await this.prisma.conversationState.upsert({
      where,
      create: { clinicId, channel, chatId, salesStage: stage, bookingRequestId: requestId, version: 1 },
      update: { salesStage: stage, bookingRequestId: requestId, version: { increment: 1 } },
    });
  }

  private snapshotOf(d: AgentDraft): Snapshot {
    const supportedAction = d.next.action === 'NONE' || d.next.action === 'OFFER_TIME' || d.next.action === 'HAND_OFF' || d.next.action === 'CLOSE';
    const allowed: Choice[] = [];
    if (supportedAction) {
      if (d.status === 'SAFE_FALLBACK' || d.next.action === 'HAND_OFF') allowed.push('HAND_OFF', 'SEND_REPLY');
      else if (d.next.action === 'OFFER_TIME' && d.options.length) allowed.push('SEND_TIMES');
      else {
        allowed.push('SEND_REPLY');
        if (d.handoffSuggestion) allowed.push('HAND_OFF');
      }
    }
    return {
      status: d.status,
      reply: d.reply,
      action: d.next.action,
      proposed: d.next.proposed,
      contentKind: d.content?.kind ?? null,
      options: d.options.map((o) => ({ label: o.label, date: o.date, time: o.time, ...(o.doctorId ? { doctorId: o.doctorId } : {}) })),
      serviceTitle: d.service,
      handoffReason: d.handoffSuggestion?.reason ?? null,
      checkRejected: d.next.check.rejected,
      exec: d.exec,
      allowed,
      unsupported: !supportedAction,
    };
  }

  private async view(row: AgentDraftRow): Promise<DraftView> {
    const snap = row.snapshot as unknown as Snapshot;
    const stale = row.status === 'PENDING' ? await this.stale(row) : { stale: false, reasons: [] as string[] };
    const previews: DraftView['previews'] = {};
    for (const c of snap.allowed) previews[c] = c === 'HAND_OFF' ? snap.exec.handoffText : snap.reply;
    const st = snap.step;
    const kind: DraftView['kind'] = st ? (st.kind === 'ASK_DATA' ? 'ask_data' : st.kind === 'ASK_CONSENT' ? 'ask_consent' : st.kind === 'CREATE_VISIT' ? 'create_visit' : 'note') : snap.unsupported ? 'unsupported' : snap.status === 'SAFE_FALLBACK' ? 'fallback' : snap.action === 'HAND_OFF' ? 'handoff' : snap.action === 'OFFER_TIME' && snap.options.length ? 'times' : snap.action === 'CLOSE' ? 'close' : 'reply';
    const open = row.status === 'PENDING' || row.status === 'UNKNOWN' ? await this.prisma.agentDraft.findFirst({ where: { clinicId: row.clinicId, channel: row.channel, chatId: row.chatId, status: 'UNKNOWN', NOT: { choice: { in: ['CREATE_VISIT', ...WRITE_STEPS] } } }, orderBy: { createdAt: 'desc' } }) : null;
    const unverified = open ? { id: open.id, choice: (open.choice as Choice | null) ?? null } : null;
    return { id: row.id, revision: row.revision, status: row.status, unverified, channelSupported: APPROVAL_CHANNELS.includes(row.channel), previews, allowed: snap.allowed, kind, options: snap.options.map((o) => o.label), handoffReason: snap.handoffReason, unsupported: snap.unsupported, stale, booking: st?.summary ?? null, note: st?.kind === 'NOTE' ? (st.note ?? null) : null, agent: true, reply: snap.reply, handoff: snap.action === 'HAND_OFF', reason: snap.handoffReason };
  }

  // Drafts are kept for a short time only (the text can echo what the patient wrote); a chat deleted on request takes its drafts with it
  async purge(now = new Date()) {
    return this.prisma.agentDraft.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - KEEP_DAYS * 86_400_000) } } });
  }
}
