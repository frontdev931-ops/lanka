'use client';

import { useT } from '../lib/i18n';
import { Alert, Badge, Icon } from './ui';

// The agent's draft for a staff member: what the patient would receive, what will be done, the offered times, the reason for a hand-over, the stale mark and
// the buttons. Technical codes are never shown: each one is translated. The structured parts (the action, the times) cannot be edited here; to write another
// text the staff member uses the ordinary reply field, which does NOT execute the action of this draft.
export type Choice = 'SEND_REPLY' | 'SEND_TIMES' | 'HAND_OFF' | 'ASK_DATA' | 'ASK_CONSENT' | 'CREATE_VISIT';
export interface BookingSummary {
  service: string | null;
  date: string;
  time: string;
  name: string | null;
  phone: string | null;
  newCard: boolean;
  doctorNote: boolean;
  preview: string;
}
export interface AgentDraftView {
  id: string;
  revision: number;
  status: string;
  previews: Partial<Record<Choice, string>>;
  allowed: Choice[];
  kind: 'reply' | 'times' | 'handoff' | 'close' | 'unsupported' | 'fallback' | 'ask_data' | 'ask_consent' | 'create_visit' | 'note';
  booking: BookingSummary | null;
  note: string | null;
  options: string[];
  handoffReason: string | null;
  unsupported: boolean;
  stale: { stale: boolean; reasons: string[] };
  unverified: { id: string; choice: Choice | null } | null;
  channelSupported: boolean;
}
export type Note = { tone: 'success' | 'warn' | 'error' | 'info'; key: string } | null;
// the keys are built from the codes the server sends (a closed list, each one translated in uk, ru and en)
export type TKey = Parameters<ReturnType<typeof useT>>[0];

const REASONS = ['asked_for_person', 'service_unknown', 'identity_needed', 'needs_clarification', 'medical', 'price_discount', 'complaint', 'time_preference_unavailable', 'online_booking_unavailable', 'urgent', 'long', 'model', 'reply_check', 'ai_limit', 'price', 'other'];
const NOTES = ['slot_gone', 'identity', 'urgent', 'no_length', 'manual', 'not_possible', 'data_wrong'];
const STALE = ['new_incoming_message', 'staff_replied', 'new_outgoing_message', 'state_changed', 'handed_to_person'];

export function AgentDraftPanel({ draft, busy, note, onApprove, onReject, onRegenerate, onResolve, onRecheck }: { draft: AgentDraftView; busy: boolean; note: Note; onApprove: (c: Choice) => void; onReject: () => void; onRegenerate: () => void; onResolve: (id: string, outcome: 'DELIVERED' | 'NOT_DELIVERED') => void; onRecheck: (id: string) => void }) {
  const t = useT();
  const waiting = draft.status === 'PENDING';
  const unknown = draft.status === 'UNKNOWN';
  const primary: Choice | null = draft.allowed[0] ?? null;
  const label: Record<Choice, string> = { SEND_REPLY: t('agent.btn.reply'), SEND_TIMES: t('agent.btn.times'), HAND_OFF: t('agent.btn.handoff'), ASK_DATA: t('agent.btn.askData'), ASK_CONSENT: t('agent.btn.askConsent'), CREATE_VISIT: t('agent.btn.createVisit') };
  const isVisit = draft.kind === 'create_visit';
  const isNote = draft.kind === 'note';
  const text = (primary && draft.previews[primary]) || '';
  const reason = draft.handoffReason ? (REASONS.includes(draft.handoffReason) ? draft.handoffReason : 'other') : null;
  return (
    <section className="agent-draft" aria-label={t('agent.title')}>
      <div className="agent-draft-head">
        <b>{t('agent.title')}</b>
        {draft.stale.stale && <Badge tone="amber">{t('agent.stale')}</Badge>}
        {unknown && <Badge tone="red">{t('agent.unknownBadge')}</Badge>}
      </div>
      {draft.stale.stale && (
        <Alert tone="warn">
          {draft.stale.reasons.map((r) => t(`agent.stale.${STALE.includes(r) ? r : 'state_changed'}` as TKey)).join(' ')} {t('agent.stale.hint')}
        </Alert>
      )}
      {note && <Alert tone={note.tone}>{t(note.key as TKey)}</Alert>}
      {unknown && !note && <Alert tone="warn">{t(isVisit ? 'agent.result.bookUnknown' : 'agent.result.unknown')}</Alert>}
      {unknown && isVisit && (
        <div className="toolbar agent-draft-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => onRecheck(draft.id)}>
            {busy ? t('agent.working') : t('agent.btn.recheck')}
          </button>
        </div>
      )}
      {draft.unverified && (
        <Alert tone="warn">
          <p>{t('agent.verify.text')}</p>
          <div className="toolbar agent-draft-actions">
            <button className="btn" disabled={busy} onClick={() => onResolve(draft.unverified!.id, 'NOT_DELIVERED')}>
              {t('agent.verify.notDelivered')}
            </button>
            <button className="btn" disabled={busy} onClick={() => onResolve(draft.unverified!.id, 'DELIVERED')}>
              {t('agent.verify.delivered')}
            </button>
          </div>
        </Alert>
      )}
      {!draft.channelSupported && <Alert tone="info">{t('agent.channelOff')}</Alert>}
      {draft.unsupported ? (
        <Alert tone="info">{t('agent.do.unsupported')}</Alert>
      ) : (
        <>
          {draft.booking && (
            <>
              <div className="agent-draft-label">{t('agent.sum.title')}</div>
              <dl className="agent-draft-sum">
                <dt>{t('agent.sum.service')}</dt>
                <dd>{draft.booking.service ?? '—'}</dd>
                <dt>{t('agent.sum.date')}</dt>
                <dd>{draft.booking.date}</dd>
                <dt>{t('agent.sum.time')}</dt>
                <dd>{draft.booking.time}</dd>
                <dt>{t('agent.sum.name')}</dt>
                <dd>{draft.booking.name ?? '—'}</dd>
                <dt>{t('agent.sum.phone')}</dt>
                <dd>{draft.booking.phone ?? '—'}</dd>
              </dl>
              {draft.booking.newCard && <p className="muted agent-draft-do">{t('agent.sum.newCard')}</p>}
              {draft.booking.doctorNote && <p className="muted agent-draft-do">{t('agent.sum.doctor')}</p>}
            </>
          )}
          {isNote ? (
            <Alert tone="info">{t(`agent.note.${draft.note && NOTES.includes(draft.note) ? draft.note : 'not_possible'}` as TKey)}</Alert>
          ) : (
            <>
              <div className="agent-draft-label">{isVisit ? t('agent.patientGetsAfter') : t('agent.patientGets')}</div>
              <div className="agent-draft-text">{text}</div>
            </>
          )}
          {draft.options.length > 0 && (
            <>
              <div className="agent-draft-label">{t('agent.options')}</div>
              <ul className="agent-draft-options">
                {draft.options.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </>
          )}
          <div className="agent-draft-label">{t('agent.willDo')}</div>
          <p className="muted agent-draft-do">{t(`agent.do.${draft.kind}` as TKey)}</p>
          {reason && (
            <p className="muted agent-draft-do">
              {t('agent.reasonLabel')}: {t(`agent.reason.${reason}` as TKey)}
            </p>
          )}
          {!isNote && <p className="muted agent-draft-note">{t(isVisit ? 'agent.approveNote.visit' : 'agent.approveNote')}</p>}
        </>
      )}
      <div className="toolbar agent-draft-actions">
        {waiting &&
          !draft.unsupported &&
          draft.allowed.map((c, i) => (
            <button key={c} className={i === 0 ? 'btn btn-primary' : 'btn'} disabled={busy || draft.stale.stale || !draft.channelSupported || draft.unverified?.choice === c} onClick={() => onApprove(c)}>
              {busy ? t('agent.working') : label[c]}
            </button>
          ))}
        <button className="btn" disabled={busy} onClick={onRegenerate}>
          <Icon name="refresh" size={16} /> {t('agent.btn.regen')}
        </button>
        {waiting && (
          <button className="btn" disabled={busy} onClick={onReject}>
            {t('agent.btn.reject')}
          </button>
        )}
      </div>
      <p className="muted agent-draft-note">{t('agent.manual')}</p>
    </section>
  );
}
