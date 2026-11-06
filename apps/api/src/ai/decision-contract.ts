// The decision contract of the AI administrator-agent (see .claude/docs/agent-administrator.md, 3.2). PURE functions only: nothing here calls the
// model, the database or a channel, and nothing in the running bot uses it yet. It says what a model answer may contain and how the code
// settles a contradictory one, the same way every time.

export const CONTENT_KINDS = ['ANSWER', 'CLARIFY', 'EXPLAIN', 'HANDLE_DOUBT'] as const;
// BOOK is deliberately absent: a booking runs only from the code path after the client's explicit yes
export const NEXT_ACTIONS = ['NONE', 'OFFER_TIME', 'ASK_CONSENT', 'COLLECT_DATA', 'HAND_OFF', 'CLOSE'] as const;
// The reasons of a hand-over: FIXED codes only. Free text of the model and anything about the patient never reaches the reason (or an analytics event).
// The model may choose among these; the classifiers and the code use their own fixed codes (urgent, long, model, reply_check, ai_limit, ...).
export const HANDOFF_REASON_CODES = ['asked_for_person', 'service_unknown', 'identity_needed', 'needs_clarification', 'medical', 'price_discount', 'complaint', 'time_preference_unavailable', 'other'] as const;
export type HandoffReasonCode = (typeof HANDOFF_REASON_CODES)[number];
export type ContentKind = (typeof CONTENT_KINDS)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];

export interface Decision {
  content: { kind: ContentKind; reply: string; after: string | null; prices: string[]; advantages: string[]; objection: string | null };
  next: { action: NextAction; service: string | null; reason: string | null };
}

// What the code knows when it settles a decision
export interface DecisionContext {
  // references the model may name (like S12), by kind
  serviceRefs: string[];
  advantageRefs: string[];
  objectionRefs: string[];
  // a service is already agreed in the dialogue / a time is already chosen
  hasService: boolean;
  hasChosenTime: boolean;
  // the last client message asks for a price
  priceQuestion: boolean;
  clarifyCount: number;
  maxClarify: number;
}

export type Resolved = { ok: true; decision: Decision; notes: string[] } | { ok: false; problem: string };

const MAX_REFS = 5;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const normRef = (r: string) => r.trim().replace(/^\[|\]$/g, '').toUpperCase();

function refs(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null;
  return [...new Set((v as string[]).map(normRef).filter(Boolean))].slice(0, MAX_REFS);
}

// Settles one raw model answer. A problem means: ask the model once more, then hand the dialogue to a person (as today).
export function resolveDecision(raw: unknown, ctx: DecisionContext): Resolved {
  if (!isObj(raw) || !isObj(raw.content) || !isObj(raw.next)) return { ok: false, problem: 'bad_contract' };
  const c = raw.content;
  const n = raw.next;
  if (!CONTENT_KINDS.includes(c.kind as ContentKind)) return { ok: false, problem: 'bad_content_kind' };
  if (n.action === 'BOOK') return { ok: false, problem: 'book_not_allowed' };
  if (!NEXT_ACTIONS.includes(n.action as NextAction)) return { ok: false, problem: 'bad_next_action' };
  if (typeof c.reply !== 'string' || !c.reply.trim()) return { ok: false, problem: 'empty_reply' };
  if (c.after !== undefined && c.after !== null && typeof c.after !== 'string') return { ok: false, problem: 'bad_contract' };
  const prices = refs(c.prices);
  const advantages = refs(c.advantages);
  if (!prices || !advantages) return { ok: false, problem: 'bad_refs' };
  if (c.objection !== undefined && c.objection !== null && typeof c.objection !== 'string') return { ok: false, problem: 'bad_refs' };
  if (n.service !== undefined && n.service !== null && typeof n.service !== 'string') return { ok: false, problem: 'bad_refs' };
  if (n.reason !== undefined && n.reason !== null && typeof n.reason !== 'string') return { ok: false, problem: 'bad_contract' };
  // a reason is accepted only for a hand-over and only as one of the fixed codes (anything else is refused, never cleaned up)
  if (n.action === 'HAND_OFF' && typeof n.reason === 'string' && !(HANDOFF_REASON_CODES as readonly string[]).includes(n.reason)) return { ok: false, problem: 'bad_reason' };
  const objection = typeof c.objection === 'string' && c.objection.trim() ? normRef(c.objection) : null;
  const service = typeof n.service === 'string' && n.service.trim() ? normRef(n.service) : null;

  // a reference that is not one of the clinic's approved entries is refused, never guessed
  if (prices.some((r) => !ctx.serviceRefs.includes(r)) || (service && !ctx.serviceRefs.includes(service))) return { ok: false, problem: 'unknown_service_ref' };
  if (advantages.some((r) => !ctx.advantageRefs.includes(r))) return { ok: false, problem: 'unknown_advantage_ref' };
  if (objection && !ctx.objectionRefs.includes(objection)) return { ok: false, problem: 'unknown_objection_ref' };

  const kind = c.kind as ContentKind;
  let action = n.action as NextAction;
  const notes: string[] = [];
  const decision: Decision = {
    content: { kind, reply: c.reply.trim(), after: typeof c.after === 'string' && c.after.trim() ? c.after.trim() : null, prices, advantages, objection },
    next: { action, service, reason: action === 'HAND_OFF' && typeof n.reason === 'string' ? n.reason : null },
  };

  // a price question is answered first, always (the answer carries the price lines; hand-over is the only exception)
  if (ctx.priceQuestion && action !== 'HAND_OFF' && !prices.length) return { ok: false, problem: 'price_question_unanswered' };
  if (kind === 'CLARIFY' && ctx.clarifyCount >= ctx.maxClarify) return { ok: false, problem: 'clarify_limit' };

  if (action === 'HAND_OFF') {
    // hand-over overrides everything: no selling, no offer; the content stays as the words of the hand-over
    if (advantages.length || objection) notes.push('selling_dropped_on_handoff');
    decision.content.advantages = [];
    decision.content.objection = null;
    decision.next.reason = decision.next.reason ?? 'other';
  } else if (action === 'CLOSE') {
    // the client declined: the content is only an acknowledgement
    if (advantages.length || objection || kind !== 'ANSWER') notes.push('selling_dropped_on_close');
    decision.content.advantages = [];
    decision.content.objection = null;
    decision.content.kind = 'ANSWER';
  } else if (action !== 'NONE') {
    if (kind === 'CLARIFY') {
      // a question and an action in one turn would be two things at once: the question stays
      notes.push('clarify_with_next_dropped');
      action = 'NONE';
    } else if (action === 'OFFER_TIME' && !service && !ctx.hasService) {
      notes.push('offer_without_service');
      action = 'NONE';
    } else if ((action === 'ASK_CONSENT' || action === 'COLLECT_DATA') && !ctx.hasChosenTime) {
      notes.push(`${action.toLowerCase()}_without_time`);
      action = 'NONE';
    }
    decision.next.action = action;
  }
  return { ok: true, decision, notes };
}
