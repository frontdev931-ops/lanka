import { DecisionContext, resolveDecision } from '../src/ai/decision-contract';

const ctx = (over: Partial<DecisionContext> = {}): DecisionContext => ({
  serviceRefs: ['S1', 'S2'],
  advantageRefs: ['A1'],
  objectionRefs: ['O1'],
  hasService: false,
  hasChosenTime: false,
  priceQuestion: false,
  clarifyCount: 0,
  maxClarify: 2,
  ...over,
});
const raw = (content: Record<string, unknown> = {}, next: Record<string, unknown> = {}) => ({
  content: { kind: 'ANSWER', reply: 'Добрий день!', ...content },
  next: { action: 'NONE', ...next },
});
const ok = (r: ReturnType<typeof resolveDecision>) => {
  if (!r.ok) throw new Error(`expected a decision, got ${r.problem}`);
  return r;
};

describe('контракт рішення моделі: чисті правила, до моделі не підключено', () => {
  it('відповідь і наступна дія — окремі частини: відповідь про ціну й пропозиція часу в одному рішенні, але пропозиція не обов’язкова', () => {
    const withOffer = ok(resolveDecision(raw({ prices: ['S1'] }, { action: 'OFFER_TIME', service: 'S1' }), ctx({ priceQuestion: true })));
    expect(withOffer.decision.content.prices).toEqual(['S1']);
    expect(withOffer.decision.next.action).toBe('OFFER_TIME');
    const without = ok(resolveDecision(raw({ prices: ['S1'] }), ctx({ priceQuestion: true })));
    expect(without.decision.next.action).toBe('NONE');
    expect(without.notes).toEqual([]);
  });

  it('BOOK модель обрати не може; невідома дія, порожня відповідь і зламана форма — проблема (повтор, далі людина)', () => {
    expect(resolveDecision(raw({}, { action: 'BOOK' }), ctx())).toEqual({ ok: false, problem: 'book_not_allowed' });
    expect(resolveDecision(raw({}, { action: 'PAY' }), ctx())).toEqual({ ok: false, problem: 'bad_next_action' });
    expect(resolveDecision(raw({ kind: 'SELL' }), ctx())).toEqual({ ok: false, problem: 'bad_content_kind' });
    expect(resolveDecision(raw({ reply: '  ' }), ctx())).toEqual({ ok: false, problem: 'empty_reply' });
    for (const bad of [null, 'text', [], {}, { content: {}, next: {} }, { content: { kind: 'ANSWER', reply: 'x' } }]) expect(resolveDecision(bad, ctx()).ok).toBe(false);
    expect(resolveDecision(raw({ prices: 'S1' }), ctx())).toEqual({ ok: false, problem: 'bad_refs' });
    expect(resolveDecision(raw({ prices: [7] }), ctx())).toEqual({ ok: false, problem: 'bad_refs' });
  });

  it('посилання лише з дозволеного списку клініки: чужа послуга, вигадана перевага чи заперечення відхиляються, а не вгадуються', () => {
    expect(resolveDecision(raw({ prices: ['S999'] }), ctx())).toEqual({ ok: false, problem: 'unknown_service_ref' });
    expect(resolveDecision(raw({}, { action: 'OFFER_TIME', service: 'S77' }), ctx())).toEqual({ ok: false, problem: 'unknown_service_ref' });
    expect(resolveDecision(raw({ kind: 'EXPLAIN', advantages: ['A9'] }), ctx())).toEqual({ ok: false, problem: 'unknown_advantage_ref' });
    expect(resolveDecision(raw({ kind: 'HANDLE_DOUBT', objection: 'O9' }), ctx())).toEqual({ ok: false, problem: 'unknown_objection_ref' });
    // the spelling of a reference is forgiven (case, brackets, repeats), nothing else
    const r = ok(resolveDecision(raw({ kind: 'EXPLAIN', prices: ['[s1]', 's1'], advantages: [' a1 '] }), ctx()));
    expect(r.decision.content.prices).toEqual(['S1']);
    expect(r.decision.content.advantages).toEqual(['A1']);
  });

  it('питання про ціну завжди отримує відповідь із цінами; єдиний виняток — передача людині', () => {
    expect(resolveDecision(raw({}, { action: 'OFFER_TIME', service: 'S1' }), ctx({ priceQuestion: true }))).toEqual({ ok: false, problem: 'price_question_unanswered' });
    expect(ok(resolveDecision(raw({}, { action: 'HAND_OFF', reason: 'price_discount' }), ctx({ priceQuestion: true }))).decision.next.action).toBe('HAND_OFF');
  });

  it('передача людині перекриває все: ні переваг, ні заперечень, причина є завжди', () => {
    const r = ok(resolveDecision(raw({ kind: 'EXPLAIN', advantages: ['A1'], objection: 'O1' }, { action: 'HAND_OFF' }), ctx()));
    expect(r.decision.next).toEqual({ action: 'HAND_OFF', service: null, reason: 'other' });
    expect(r.decision.content.advantages).toEqual([]);
    expect(r.decision.content.objection).toBeNull();
    expect(r.notes).toEqual(['selling_dropped_on_handoff']);
  });

  it('причина передачі — лише фіксований код: слова чи речення відхиляються, для інших дій причина відкидається', () => {
    expect(resolveDecision(raw({}, { action: 'HAND_OFF', reason: 'Пацієнтка питає про лікування' }), ctx())).toEqual({ ok: false, problem: 'bad_reason' });
    expect(ok(resolveDecision(raw({}, { action: 'HAND_OFF', reason: 'identity_needed' }), ctx())).decision.next.reason).toBe('identity_needed');
    expect(ok(resolveDecision(raw({}, { action: 'NONE', reason: 'anything the model wrote' }), ctx())).decision.next.reason).toBeNull();
  });

  it('відмова клієнта: лише ввічлива відповідь, без продажу', () => {
    const r = ok(resolveDecision(raw({ kind: 'EXPLAIN', advantages: ['A1'] }, { action: 'CLOSE' }), ctx()));
    expect(r.decision.next.action).toBe('CLOSE');
    expect(r.decision.content).toMatchObject({ kind: 'ANSWER', advantages: [], objection: null });
    expect(r.notes).toEqual(['selling_dropped_on_close']);
  });

  it('питання і дія в одному ході — дві речі одразу: лишається питання, дія знімається', () => {
    for (const action of ['OFFER_TIME', 'ASK_CONSENT', 'COLLECT_DATA']) {
      const r = ok(resolveDecision(raw({ kind: 'CLARIFY' }, { action, service: action === 'OFFER_TIME' ? 'S1' : null }), ctx({ hasChosenTime: true, hasService: true })));
      expect(r.decision.next.action).toBe('NONE');
      expect(r.notes).toEqual(['clarify_with_next_dropped']);
    }
  });

  it('умови дій перевіряє код: пропозиція часу без послуги, згода й збір даних без обраного часу знімаються; з умовами проходять', () => {
    expect(ok(resolveDecision(raw({}, { action: 'OFFER_TIME' }), ctx())).notes).toEqual(['offer_without_service']);
    expect(ok(resolveDecision(raw({}, { action: 'OFFER_TIME' }), ctx({ hasService: true }))).decision.next.action).toBe('OFFER_TIME');
    expect(ok(resolveDecision(raw({}, { action: 'ASK_CONSENT' }), ctx())).notes).toEqual(['ask_consent_without_time']);
    expect(ok(resolveDecision(raw({}, { action: 'COLLECT_DATA' }), ctx())).notes).toEqual(['collect_data_without_time']);
    expect(ok(resolveDecision(raw({}, { action: 'ASK_CONSENT' }), ctx({ hasChosenTime: true }))).decision.next.action).toBe('ASK_CONSENT');
  });

  it('уточнень не більше ліміту; після ліміту — проблема (далі людина)', () => {
    expect(ok(resolveDecision(raw({ kind: 'CLARIFY' }), ctx({ clarifyCount: 1 }))).decision.content.kind).toBe('CLARIFY');
    expect(resolveDecision(raw({ kind: 'CLARIFY' }), ctx({ clarifyCount: 2 }))).toEqual({ ok: false, problem: 'clarify_limit' });
  });

  it('те саме рішення дає той самий результат щоразу (без випадковості)', () => {
    const input = raw({ kind: 'EXPLAIN', prices: ['S2'], advantages: ['A1'] }, { action: 'OFFER_TIME', service: 'S2' });
    expect(JSON.stringify(resolveDecision(input, ctx()))).toBe(JSON.stringify(resolveDecision(input, ctx())));
  });
});
