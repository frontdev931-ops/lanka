'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { fmtDateTime } from '../../../lib/ui';
import { useI18n } from '../../../lib/i18n';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';
import { useConfirm } from '../../../components/ConfirmDialog';

interface Schedule {
  id: string;
  reportName: string | null;
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  hour: number;
  weekday: number;
  monthDay: number;
  format: 'XLSX' | 'PDF';
  recipientIds: string[];
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}
interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}
interface AlertRow {
  kind: 'CANCEL_RATE' | 'RETURN_DROP' | 'STALE_REQUESTS';
  threshold: number;
  windowDays: number;
  hours: number;
  enabled: boolean;
  lastFiredAt: string | null;
  lastValue: number | null;
}
interface Saved {
  id: string;
  name: string;
}

// Reports mailed on a schedule and signals for the manager. Set up by the owner and the manager.
export default function InsightsPage() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [data, setData] = useState<{ schedules: Schedule[]; members: Member[] } | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ savedReportId: '', frequency: 'WEEKLY', hour: 8, weekday: 1, monthDay: 1, format: 'XLSX', recipientIds: [] as string[] });
  const [edits, setEdits] = useState<Record<string, { threshold?: string; windowDays?: string; hours?: string }>>({});

  const load = useCallback(async () => {
    try {
      setData(await api('/scheduled-reports'));
      setAlerts(await api('/alerts'));
      setSaved(await api('/report-builder/saved'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
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

  if (!data || !alerts) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  const when = (s: Schedule) => (s.frequency === 'DAILY' ? t('ins.daily', { h: s.hour }) : s.frequency === 'WEEKLY' ? t('ins.weekly', { d: t(`ins.wd${s.weekday}` as 'ins.wd1'), h: s.hour }) : t('ins.monthly', { n: s.monthDay, h: s.hour }));
  const names = (ids: string[]) => ids.map((id) => data.members.find((m) => m.id === id)?.name ?? '?').join(', ');
  const alertTitle = (a: AlertRow) => t(`ins.alert.${a.kind}` as 'ins.alert.CANCEL_RATE');

  return (
    <>
      {dialog}
      <PageHeader title={t('ins.title')} subtitle={t('ins.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      <Card title={t('ins.reports')}>
        <p className="rule" style={{ marginTop: 0 }}>{t('ins.reportsHint')}</p>
        {data.schedules.length === 0 ? (
          <Empty title={t('ins.noSchedules')} />
        ) : (
          data.schedules.map((s) => (
            <div key={s.id} className="req-item">
              <span className="chat-name">
                <b>{s.reportName ?? t('ins.deleted')}</b>
                <Badge>{s.format}</Badge>
                {!s.enabled && <Badge tone="amber">{t('kb.off')}</Badge>}
                {s.lastStatus && <Badge tone={s.lastStatus === 'OK' ? 'green' : 'amber'}>{s.lastStatus}</Badge>}
              </span>
              <span>{when(s)} · {names(s.recipientIds)}</span>
              <span className="muted chat-time">{t('ins.next')}: {fmtDateTime(s.nextRunAt)}{s.lastError ? ` · ${s.lastError}` : ''}</span>
              <div className="toolbar">
                <button className="btn btn-sm" disabled={busy} onClick={() => act(async () => { const r = await api<{ sent: number; failed: number }>(`/scheduled-reports/${s.id}/run`, { method: 'POST' }); setInfo(t('ins.sentNow', { a: r.sent, b: r.failed })); })}>{t('ins.sendNow')}</button>
                <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api(`/scheduled-reports/${s.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !s.enabled }) }))}>{s.enabled ? t('kb.disable') : t('kb.enable')}</button>
                <button className="btn btn-sm" disabled={busy} onClick={async () => (await ask(t('ins.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') })) && act(() => api(`/scheduled-reports/${s.id}`, { method: 'DELETE' }))}>{t('common.delete')}</button>
              </div>
            </div>
          ))
        )}
      </Card>

      <Card title={t('ins.add')}>
        {saved.length === 0 ? (
          <p className="rule" style={{ marginTop: 0 }}>{t('ins.noSaved')}</p>
        ) : (
          <>
            <div className="toolbar" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ margin: 0 }}>
                <span>{t('ins.report')}</span>
                <select className="select" value={form.savedReportId} onChange={(e) => setForm({ ...form, savedReportId: e.target.value })}>
                  <option value="">—</option>
                  {saved.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <label className="field" style={{ margin: 0 }}>
                <span>{t('ins.frequency')}</span>
                <select className="select" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                  <option value="DAILY">{t('ins.f.DAILY')}</option>
                  <option value="WEEKLY">{t('ins.f.WEEKLY')}</option>
                  <option value="MONTHLY">{t('ins.f.MONTHLY')}</option>
                </select>
              </label>
              {form.frequency === 'WEEKLY' && (
                <label className="field" style={{ margin: 0 }}>
                  <span>{t('ins.weekday')}</span>
                  <select className="select" value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{t(`ins.wd${d}` as 'ins.wd1')}</option>)}
                  </select>
                </label>
              )}
              {form.frequency === 'MONTHLY' && (
                <label className="field" style={{ margin: 0 }}>
                  <span>{t('ins.monthDay')}</span>
                  <input className="input" type="number" min={1} max={28} style={{ width: 90 }} value={form.monthDay} onChange={(e) => setForm({ ...form, monthDay: Number(e.target.value) })} />
                </label>
              )}
              <label className="field" style={{ margin: 0 }}>
                <span>{t('ins.hour')}</span>
                <input className="input" type="number" min={0} max={23} style={{ width: 90 }} value={form.hour} onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })} />
              </label>
              <label className="field" style={{ margin: 0 }}>
                <span>{t('ins.format')}</span>
                <select className="select" value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
                  <option value="XLSX">Excel</option>
                  <option value="PDF">PDF</option>
                </select>
              </label>
            </div>
            <p className="rule">{t('ins.recipients')}</p>
            {data.members.map((m) => (
              <label key={m.id} className="check-row">
                <input type="checkbox" checked={form.recipientIds.includes(m.id)} onChange={(e) => setForm({ ...form, recipientIds: e.target.checked ? [...form.recipientIds, m.id] : form.recipientIds.filter((x) => x !== m.id) })} />
                <span>{m.name} <span className="muted">· {m.email} · {m.role}</span></span>
              </label>
            ))}
            <p className="muted" style={{ fontSize: 13 }}>{t('ins.privacy')}</p>
            <button className="btn btn-primary" disabled={busy || !form.savedReportId || form.recipientIds.length === 0 || form.recipientIds.length > 5} onClick={() => act(async () => { await api('/scheduled-reports', { method: 'POST', body: JSON.stringify(form) }); setForm({ ...form, savedReportId: '', recipientIds: [] }); }, t('ins.created'))}>{t('ins.addBtn')}</button>
          </>
        )}
      </Card>

      <Card title={t('ins.alerts')}>
        <p className="rule" style={{ marginTop: 0 }}>{t('ins.alertsHint')}</p>
        {alerts.map((a) => {
          const e = edits[a.kind] ?? {};
          const dirty = Object.keys(e).length > 0;
          return (
            <div key={a.kind} className="req-item">
              <span className="chat-name">
                <b>{alertTitle(a)}</b>
                <Badge tone={a.enabled ? 'green' : undefined}>{a.enabled ? t('wc.on') : t('wc.off')}</Badge>
              </span>
              <div className="toolbar">
                <label className="field" style={{ margin: 0 }}>
                  <span>{a.kind === 'STALE_REQUESTS' ? t('ins.thresholdCount') : t('ins.thresholdPct')}</span>
                  <input className="input" type="number" min={1} style={{ width: 100 }} value={e.threshold ?? a.threshold} onChange={(ev) => setEdits({ ...edits, [a.kind]: { ...e, threshold: ev.target.value } })} />
                </label>
                {a.kind === 'STALE_REQUESTS' ? (
                  <label className="field" style={{ margin: 0 }}>
                    <span>{t('ins.hours')}</span>
                    <input className="input" type="number" min={1} max={72} style={{ width: 100 }} value={e.hours ?? a.hours} onChange={(ev) => setEdits({ ...edits, [a.kind]: { ...e, hours: ev.target.value } })} />
                  </label>
                ) : (
                  <label className="field" style={{ margin: 0 }}>
                    <span>{t('ins.windowDays')}</span>
                    <input className="input" type="number" min={3} max={60} style={{ width: 100 }} value={e.windowDays ?? a.windowDays} onChange={(ev) => setEdits({ ...edits, [a.kind]: { ...e, windowDays: ev.target.value } })} />
                  </label>
                )}
              </div>
              {a.lastFiredAt && <span className="muted chat-time">{t('ins.lastFired')}: {fmtDateTime(a.lastFiredAt)} ({a.lastValue})</span>}
              <div className="toolbar">
                <button className="btn btn-sm" disabled={busy || !dirty} onClick={() => act(async () => { await api(`/alerts/${a.kind}`, { method: 'PATCH', body: JSON.stringify({ ...(e.threshold ? { threshold: Number(e.threshold) } : {}), ...(e.windowDays ? { windowDays: Number(e.windowDays) } : {}), ...(e.hours ? { hours: Number(e.hours) } : {}) }) }); setEdits({ ...edits, [a.kind]: {} }); }, t('wc.saved'))}>{t('common.save')}</button>
                <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => api(`/alerts/${a.kind}`, { method: 'PATCH', body: JSON.stringify({ enabled: !a.enabled }) }))}>{a.enabled ? t('kb.disable') : t('kb.enable')}</button>
              </div>
            </div>
          );
        })}
      </Card>
    </>
  );
}
