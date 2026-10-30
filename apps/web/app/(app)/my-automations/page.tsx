'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { fmtDateTime } from '../../../lib/ui';
import { useI18n } from '../../../lib/i18n';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';
import { useConfirm } from '../../../components/ConfirmDialog';

type TriggerType = 'VISIT_BEFORE' | 'VISIT_AFTER' | 'NO_VISIT' | 'TREATMENT_OPEN' | 'BIRTHDAY';
interface Trigger {
  type: TriggerType;
  hours?: number;
  status?: string;
  delayHours?: number;
  days?: number;
}
interface Conditions {
  noOtherFutureVisit?: boolean;
  source?: string;
  minVisits?: number;
  maxVisits?: number;
  doctor?: string;
  service?: string;
}
interface Draft {
  name: string;
  kind: 'service' | 'marketing';
  trigger: Trigger;
  conditions: Conditions;
  action: { type: 'SEND_MESSAGE' | 'CREATE_REQUEST'; text: string };
  stop: { ifBooked?: boolean; ifReplied?: boolean };
  templateKey?: string | null;
}
interface Automation extends Draft {
  id: string;
  enabled: boolean;
  lastRun: { at: string; candidates: number; queued: number; requests: number } | null;
}
interface Report {
  candidates: number;
  toDo: number;
  alreadyDone: number;
  skipped: Record<string, number>;
  sample: { patient: string; text: string }[];
}
interface Journal {
  runs: { id: string; at: string; candidates: number; queued: number; requests: number; skipped: Record<string, number> }[];
  messages: Record<string, number>;
}

const EMPTY: Draft = { name: '', kind: 'service', trigger: { type: 'VISIT_AFTER', status: 'VISITED', delayHours: 20 }, conditions: {}, action: { type: 'SEND_MESSAGE', text: '' }, stop: {} };
const TRIGGERS: TriggerType[] = ['VISIT_BEFORE', 'VISIT_AFTER', 'NO_VISIT', 'TREATMENT_OPEN', 'BIRTHDAY'];

// Automations of the clinic: "when this happens and the patient fits, do that". A preview shows who it would reach before anything is switched on.
export default function MyAutomationsPage() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [list, setList] = useState<Automation[] | null>(null);
  const [templates, setTemplates] = useState<(Draft & { key: string })[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [journal, setJournal] = useState<{ id: string; data: Journal } | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<{ automations: Automation[]; templates: (Draft & { key: string })[] }>('/custom-automations')
        .then((r) => {
          setList(r.automations);
          setTemplates(r.templates);
        })
        .catch((e) => setError((e as Error).message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!list) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  const num = (v: string) => (v === '' ? undefined : Number(v));
  const setTrigger = (type: TriggerType) => setDraft((d) => d && { ...d, trigger: type === 'VISIT_BEFORE' ? { type, hours: 3 } : type === 'VISIT_AFTER' ? { type, status: 'VISITED', delayHours: 20 } : type === 'NO_VISIT' ? { type, days: 365 } : type === 'TREATMENT_OPEN' ? { type, days: 21 } : { type } });
  const visitTrigger = draft && (draft.trigger.type === 'VISIT_BEFORE' || draft.trigger.type === 'VISIT_AFTER');
  const body = (d: Draft) => JSON.stringify({ ...d, conditions: Object.fromEntries(Object.entries(d.conditions).filter(([, v]) => v !== undefined && v !== '' && v !== false)) });
  const skipLabel = (k: string) => t(`ma.skip.${k}` as 'ma.skip.source');

  return (
    <>
      {dialog}
      <PageHeader title={t('ma.title')} subtitle={t('ma.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      {!draft && (
        <Card title={t('ma.start')}>
          <p className="rule" style={{ marginTop: 0 }}>{t('ma.startHint')}</p>
          <div className="toolbar">
            {templates.map((x) => (
              <button key={x.key} className="btn" onClick={() => { setDraft({ ...x, conditions: x.conditions ?? {}, stop: x.stop ?? {}, templateKey: x.key }); setEditId(null); setReport(null); }}>{x.name}</button>
            ))}
            <button className="btn btn-primary" onClick={() => { setDraft(EMPTY); setEditId(null); setReport(null); }}>{t('ma.blank')}</button>
          </div>
        </Card>
      )}

      {draft && (
        <Card title={editId ? t('ma.edit') : t('ma.new')}>
          <label className="field"><span>{t('ma.name')}</span><input className="input" maxLength={120} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>

          <p className="rule"><b>1. {t('ma.when')}</b></p>
          <div className="toolbar" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ margin: 0 }}>
              <span>{t('ma.trigger')}</span>
              <select className="select" value={draft.trigger.type} onChange={(e) => setTrigger(e.target.value as TriggerType)}>
                {TRIGGERS.map((x) => <option key={x} value={x}>{t(`ma.t.${x}` as 'ma.t.BIRTHDAY')}</option>)}
              </select>
            </label>
            {draft.trigger.type === 'VISIT_BEFORE' && <label className="field" style={{ margin: 0 }}><span>{t('ma.hoursBefore')}</span><input className="input" type="number" min={1} max={72} style={{ width: 100 }} value={draft.trigger.hours ?? ''} onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, hours: num(e.target.value) } })} /></label>}
            {draft.trigger.type === 'VISIT_AFTER' && (
              <>
                <label className="field" style={{ margin: 0 }}>
                  <span>{t('ma.status')}</span>
                  <select className="select" value={draft.trigger.status} onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, status: e.target.value } })}>
                    {['VISITED', 'DID_NOT_COME', 'CANCELLED', 'MOVED'].map((s) => <option key={s} value={s}>{t(`ma.s.${s}` as 'ma.s.VISITED')}</option>)}
                  </select>
                </label>
                <label className="field" style={{ margin: 0 }}><span>{t('ma.delay')}</span><input className="input" type="number" min={0} max={168} style={{ width: 100 }} value={draft.trigger.delayHours ?? ''} onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, delayHours: num(e.target.value) } })} /></label>
              </>
            )}
            {(draft.trigger.type === 'NO_VISIT' || draft.trigger.type === 'TREATMENT_OPEN') && <label className="field" style={{ margin: 0 }}><span>{t('ma.days')}</span><input className="input" type="number" min={7} max={1095} style={{ width: 110 }} value={draft.trigger.days ?? ''} onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, days: num(e.target.value) } })} /></label>}
          </div>

          <p className="rule"><b>2. {t('ma.who')}</b> <span className="muted">{t('ma.whoHint')}</span></p>
          <div className="toolbar" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ margin: 0 }}><span>{t('ma.source')}</span><input className="input" style={{ width: 150 }} value={draft.conditions.source ?? ''} onChange={(e) => setDraft({ ...draft, conditions: { ...draft.conditions, source: e.target.value } })} placeholder="Instagram" /></label>
            <label className="field" style={{ margin: 0 }}><span>{t('ma.minVisits')}</span><input className="input" type="number" min={0} style={{ width: 90 }} value={draft.conditions.minVisits ?? ''} onChange={(e) => setDraft({ ...draft, conditions: { ...draft.conditions, minVisits: num(e.target.value) } })} /></label>
            <label className="field" style={{ margin: 0 }}><span>{t('ma.maxVisits')}</span><input className="input" type="number" min={0} style={{ width: 90 }} value={draft.conditions.maxVisits ?? ''} onChange={(e) => setDraft({ ...draft, conditions: { ...draft.conditions, maxVisits: num(e.target.value) } })} /></label>
            {visitTrigger && <label className="field" style={{ margin: 0 }}><span>{t('ma.doctor')}</span><input className="input" style={{ width: 150 }} value={draft.conditions.doctor ?? ''} onChange={(e) => setDraft({ ...draft, conditions: { ...draft.conditions, doctor: e.target.value } })} /></label>}
            {visitTrigger && <label className="field" style={{ margin: 0 }}><span>{t('ma.service')}</span><input className="input" style={{ width: 150 }} value={draft.conditions.service ?? ''} onChange={(e) => setDraft({ ...draft, conditions: { ...draft.conditions, service: e.target.value } })} /></label>}
          </div>
          <label className="check-row"><input type="checkbox" checked={!!draft.conditions.noOtherFutureVisit} onChange={(e) => setDraft({ ...draft, conditions: { ...draft.conditions, noOtherFutureVisit: e.target.checked } })} /><span>{t('ma.noFuture')}</span></label>

          <p className="rule"><b>3. {t('ma.do')}</b></p>
          <div className="toolbar" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ margin: 0 }}>
              <span>{t('ma.action')}</span>
              <select className="select" value={draft.action.type} onChange={(e) => setDraft({ ...draft, action: { ...draft.action, type: e.target.value as 'SEND_MESSAGE' | 'CREATE_REQUEST' } })}>
                <option value="SEND_MESSAGE">{t('ma.a.SEND_MESSAGE')}</option>
                <option value="CREATE_REQUEST">{t('ma.a.CREATE_REQUEST')}</option>
              </select>
            </label>
            {draft.action.type === 'SEND_MESSAGE' && (
              <label className="field" style={{ margin: 0 }}>
                <span>{t('ma.kind')}</span>
                <select className="select" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'service' | 'marketing' })}>
                  <option value="service">{t('ma.k.service')}</option>
                  <option value="marketing">{t('ma.k.marketing')}</option>
                </select>
              </label>
            )}
          </div>
          <label className="field"><span>{draft.action.type === 'SEND_MESSAGE' ? t('ma.text') : t('ma.requestText')}</span><textarea className="input" rows={3} maxLength={600} value={draft.action.text} onChange={(e) => setDraft({ ...draft, action: { ...draft.action, text: e.target.value } })} /></label>
          <p className="muted" style={{ fontSize: 13 }}>{t('ma.vars')} {draft.kind === 'marketing' && draft.action.type === 'SEND_MESSAGE' ? t('ma.marketingNote') : ''}</p>

          {draft.action.type === 'SEND_MESSAGE' && (
            <>
              <p className="rule"><b>4. {t('ma.stop')}</b> <span className="muted">{t('ma.stopHint')}</span></p>
              <label className="check-row"><input type="checkbox" checked={!!draft.stop.ifBooked} onChange={(e) => setDraft({ ...draft, stop: { ...draft.stop, ifBooked: e.target.checked } })} /><span>{t('ma.stopBooked')}</span></label>
              <label className="check-row"><input type="checkbox" checked={!!draft.stop.ifReplied} onChange={(e) => setDraft({ ...draft, stop: { ...draft.stop, ifReplied: e.target.checked } })} /><span>{t('ma.stopReplied')}</span></label>
            </>
          )}

          {report && (
            <Alert tone="info">
              {t('ma.previewResult', { c: report.candidates, n: report.toDo, d: report.alreadyDone })}
              {Object.keys(report.skipped).length > 0 && <> {t('ma.skipped')}: {Object.entries(report.skipped).map(([k, v]) => `${skipLabel(k)} ${v}`).join(', ')}.</>}
              {report.sample.map((s, i) => <div key={i} className="muted" style={{ fontSize: 13 }}>«{s.text}» → {s.patient}</div>)}
            </Alert>
          )}
          <div className="toolbar" style={{ marginTop: 8 }}>
            <button className="btn" disabled={busy} onClick={() => act(async () => setReport(await api<Report>(editId ? `/custom-automations/${editId}/preview` : '/custom-automations/preview', editId ? undefined : { method: 'POST', body: body(draft) })))}>{t('ma.preview')}</button>
            <button className="btn btn-primary" disabled={busy || !draft.name.trim()} onClick={() => act(async () => { await api(editId ? `/custom-automations/${editId}` : '/custom-automations', { method: editId ? 'PATCH' : 'POST', body: body(draft) }); setDraft(null); setEditId(null); setReport(null); }, t('ma.saved'))}>{t('common.save')}</button>
            <button className="btn" onClick={() => { setDraft(null); setEditId(null); setReport(null); }}>{t('common.cancel')}</button>
          </div>
        </Card>
      )}

      <Card flush title={t('ma.mine')}>
        {list.length === 0 ? (
          <Empty title={t('ma.empty')}>{t('ma.emptyHint')}</Empty>
        ) : (
          list.map((a) => (
            <div key={a.id} className="req-item">
              <span className="chat-name">
                <b>{a.name}</b>
                <Badge tone={a.enabled ? 'green' : undefined}>{a.enabled ? t('wc.on') : t('wc.off')}</Badge>
                <Badge>{a.action.type === 'SEND_MESSAGE' ? t(`ma.k.${a.kind}` as 'ma.k.service') : t('ma.a.CREATE_REQUEST')}</Badge>
              </span>
              <span>{t(`ma.t.${a.trigger.type}` as 'ma.t.BIRTHDAY')}</span>
              {a.lastRun && <span className="muted chat-time">{t('ma.lastRun')}: {fmtDateTime(a.lastRun.at)} · {t('ma.found')} {a.lastRun.candidates}, {t('ma.queued')} {a.lastRun.queued + a.lastRun.requests}</span>}
              <div className="toolbar">
                <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => api(`/custom-automations/${a.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !a.enabled }) }))}>{a.enabled ? t('kb.disable') : t('kb.enable')}</button>
                <button className="btn btn-sm" disabled={busy} onClick={() => { setDraft({ name: a.name, kind: a.kind, trigger: a.trigger, conditions: a.conditions, action: a.action, stop: a.stop ?? {} }); setEditId(a.id); setReport(null); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{t('ma.edit')}</button>
                <button className="btn btn-sm" disabled={busy} onClick={() => act(async () => setJournal({ id: a.id, data: await api<Journal>(`/custom-automations/${a.id}/journal`) }))}>{t('ma.journal')}</button>
                <button className="btn btn-sm" disabled={busy} onClick={async () => (await ask(t('ma.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') })) && act(() => api(`/custom-automations/${a.id}`, { method: 'DELETE' }))}>{t('common.delete')}</button>
              </div>
              {journal?.id === a.id && (
                <div className="chat-link">
                  <p className="rule" style={{ marginTop: 0 }}>{t('ma.messages')}: {Object.entries(journal.data.messages).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}</p>
                  {journal.data.runs.length === 0 ? <span className="muted">{t('ma.noRuns')}</span> : journal.data.runs.map((r) => (
                    <div key={r.id} className="muted" style={{ fontSize: 13 }}>
                      {fmtDateTime(r.at)}: {t('ma.found')} {r.candidates}, {t('ma.queued')} {r.queued + r.requests}{Object.keys(r.skipped).length ? ` · ${t('ma.skipped')}: ${Object.entries(r.skipped).map(([k, v]) => `${skipLabel(k)} ${v}`).join(', ')}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </Card>
    </>
  );
}
