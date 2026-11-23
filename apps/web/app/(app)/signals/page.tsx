'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Key, useI18n } from '../../../lib/i18n';
import { fmtDate, fmtDateTime } from '../../../lib/ui';
import { Alert, Badge, Loading, PageHeader } from '../../../components/ui';
import { ProHint } from '../../../components/ProHint';
import { usePushDevice } from '../../../components/PushCard';

type State = 'fired' | 'ok' | 'insufficient' | 'needs_sync' | 'never' | 'not_connected';
type Kind = 'CANCEL_RATE' | 'NO_REBOOK' | 'OVERDUE_TASKS' | 'PAYMENTS_DROP' | 'RETURN_DROP' | 'STALE_REQUESTS' | 'SYNC_OVERDUE' | 'UNFINISHED_NO_NEXT';
interface Signal {
  kind: Kind;
  state: State;
  threshold: number;
  windowDays: number;
  hours: number;
  limits: { threshold: [number, number]; windowDays: [number, number] | null; hours: [number, number] | null };
  telegramOn: boolean;
  emailOn: boolean;
  pushOn: boolean;
  lastFiredAt: string | null;
  telegramSentAt: string | null;
  // null: the signal shows its own comparison (no report substantiates it)
  link: string | null;
  value?: number;
  count?: number;
  base?: number;
  need?: number;
  reason?: 'currency';
  from?: string;
  to?: string;
  prevFrom?: string;
  prevTo?: string;
  amount?: number;
  prevAmount?: number;
  currency?: string;
  oldestDays?: number;
  lookbackDays?: number;
  lastSyncAt?: string;
}
interface View {
  inPlan: boolean;
  checkedAt: string;
  sync: { lastSyncAt: string | null; fresh: boolean; connected: boolean } | null;
  // the clinic's staff Telegram chat (null: not connected)
  telegram: { title: string } | null;
  signals: Signal[];
}

const TONE: Record<State, 'red' | 'green' | 'gray' | 'amber'> = { fired: 'red', ok: 'green', insufficient: 'gray', needs_sync: 'amber', never: 'amber', not_connected: 'gray' };
const ORDER: State[] = ['fired', 'ok', 'insufficient', 'needs_sync', 'never', 'not_connected'];
const PCT: Kind[] = ['CANCEL_RATE', 'RETURN_DROP', 'PAYMENTS_DROP'];
// a period's end is exclusive (the start of the next day): show the last day it covers
const lastDay = (iso: string) => fmtDate(new Date(Date.parse(iso) - 1).toISOString());

// Reports → "Signals": deviations in the clinic's work measured now from its own data (GET /signals), with each signal's settings: the
// threshold, delivery to the staff Telegram chat and (under "How it is calculated") email and phone notifications. Saving sends nothing.
export default function SignalsPage() {
  const { t } = useI18n();
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState('');
  // Push on this device: only in the installed app; a browser tab shows no Push controls (the saved preferences stay)
  const device = usePushDevice();
  const load = useCallback(() => {
    setError('');
    return api<View>('/signals').then(setV).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const header = <PageHeader title={t('sig.title')} subtitle={t('sig.subtitle')} />;
  if (error && !v)
    return (
      <>
        {header}
        <Alert tone="error">
          {t('sig.error')} <button className="btn btn-sm" onClick={() => void load()}>{t('sig.retry')}</button>
        </Alert>
      </>
    );
  if (!v) return <>{header}<Loading /></>;
  if (!v.inPlan)
    return (
      <>
        {header}
        <ProHint feature="advanced_analytics" />
        <p className="rule">{t('sig.notInPlan')}</p>
      </>
    );

  const list = [...v.signals].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
  const fired = list.filter((s) => s.state === 'fired').length;
  const measured = list.filter((s) => s.state === 'fired' || s.state === 'ok').length;

  return (
    <>
      {header}
      {v.sync && v.sync.connected && !v.sync.fresh && (
        <Alert tone="warn">
          {v.sync.lastSyncAt ? t('sig.syncOld', { date: fmtDateTime(v.sync.lastSyncAt) }) : t('sig.syncNever')} <Link href="/settings">{t('sig.toSync')}</Link>
        </Alert>
      )}
      {fired > 0 ? (
        <Alert tone="warn">{t('sig.summaryFired', { n: fired })}</Alert>
      ) : measured === list.length && measured > 0 ? (
        <Alert tone="success">{t('sig.summaryOk')}</Alert>
      ) : measured > 0 ? (
        <Alert tone="info">{t('sig.summaryPartial')}</Alert>
      ) : (
        <Alert tone="info">{t('sig.summaryNone')}</Alert>
      )}
      <p className="muted sig-dest">
        {v.telegram ? t('sig.dest', { title: v.telegram.title }) : <>{t('sig.destNone')} <Link href="/settings?tab=channels">{t('sig.destConnect')}</Link></>}
      </p>
      {device.state === 'ask' && (
        <Alert tone="info">
          {t('sig.pushAsk')} <button className="btn btn-sm" disabled={device.busy} onClick={() => void device.enable()}>{t('sig.pushEnable')}</button>
        </Alert>
      )}
      {device.state === 'denied' && <Alert tone="warn">{t('sig.pushDenied')}</Alert>}
      {device.error && <Alert tone="error">{device.error}</Alert>}
      <div className="signal-list">
        {list.map((s) => <SignalCard key={s.kind} s={s} canTelegram={!!v.telegram} pushHere={device.state === 'active'} onSaved={load} />)}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>{t('sig.checkedAt', { date: fmtDateTime(v.checkedAt) })}</p>
    </>
  );
}

function SignalCard({ s, canTelegram, pushHere, onSaved }: { s: Signal; canTelegram: boolean; pushHere: boolean; onSaved: () => Promise<unknown> }) {
  const { t } = useI18n();
  const [threshold, setThreshold] = useState(String(s.threshold));
  const [days, setDays] = useState(String(s.windowDays));
  const [hours, setHours] = useState(String(s.hours));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // the switches answer at once; a failed save puts them back
  const [tg, setTg] = useState(s.telegramOn);
  const [em, setEm] = useState(s.emailOn);
  const [pu, setPu] = useState(s.pushOn);
  useEffect(() => {
    setTg(s.telegramOn);
    setEm(s.emailOn);
    setPu(s.pushOn);
  }, [s.telegramOn, s.emailOn, s.pushOn]);
  useEffect(() => {
    setThreshold(String(s.threshold));
    setDays(String(s.windowDays));
    setHours(String(s.hours));
  }, [s.threshold, s.windowDays, s.hours]);

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/alerts/${s.kind}`, { method: 'PATCH', body: JSON.stringify(body) });
      await onSaved();
      setMsg({ ok: true, text: t('sig.saved') });
    } catch (e) {
      setTg(s.telegramOn);
      setEm(s.emailOn);
      setPu(s.pushOn);
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const unit = (c?: string) => (c === 'UAH' ? t('billing.uah') : c ?? '');
  const period = (a?: string, b?: string) => (a && b ? `${fmtDate(a)} — ${lastDay(b)}` : '');
  const what = (): string => {
    if (s.state === 'needs_sync') return t('sig.needsSync');
    if (s.state === 'never') return t('sig.SYNC_OVERDUE.never');
    if (s.state === 'not_connected') return t('sig.SYNC_OVERDUE.notConnected');
    if (s.state === 'insufficient') {
      if (s.reason === 'currency') return t('sig.PAYMENTS_DROP.currency');
      if (s.kind === 'RETURN_DROP' || s.kind === 'PAYMENTS_DROP') return t(`sig.${s.kind}.insufficient` as Key, { n: s.base ?? 0, need: s.need ?? 0, period: period(s.from, s.to) });
      return t('sig.insufficient', { n: s.base ?? 0, need: s.need ?? 0, period: period(s.from, s.to) });
    }
    const v2 = s.value ?? 0;
    const dir = v2 > 0 ? 'less' : v2 < 0 ? 'more' : 'same';
    switch (s.kind) {
      case 'CANCEL_RATE':
        return t('sig.CANCEL_RATE.what', { v: v2, n: s.count ?? 0, total: s.base ?? 0, period: period(s.from, s.to) });
      case 'RETURN_DROP':
        return t(`sig.RETURN_DROP.${dir}` as Key, { cur: s.count ?? 0, prev: s.base ?? 0, v: Math.abs(v2), period: period(s.from, s.to), prevPeriod: period(s.prevFrom, s.prevTo) });
      case 'PAYMENTS_DROP':
        return t(`sig.PAYMENTS_DROP.${dir}` as Key, { cur: (s.amount ?? 0).toLocaleString(), prev: (s.prevAmount ?? 0).toLocaleString(), u: unit(s.currency), v: Math.abs(v2), period: period(s.from, s.to), prevPeriod: period(s.prevFrom, s.prevTo) });
      case 'STALE_REQUESTS':
        return t('sig.STALE_REQUESTS.what', { n: s.count ?? 0, h: s.hours, total: s.base ?? 0 });
      case 'UNFINISHED_NO_NEXT':
        if (!s.count) return t('sig.UNFINISHED_NO_NEXT.none', { d: s.windowDays, total: s.base ?? 0 });
        return t('sig.UNFINISHED_NO_NEXT.what', { n: s.count ?? 0, d: s.windowDays, total: s.base ?? 0, oldest: s.oldestDays ?? 0 });
      case 'NO_REBOOK':
        return t('sig.NO_REBOOK.what', { n: s.count ?? 0, total: s.base ?? 0, period: period(s.from, s.to) });
      case 'OVERDUE_TASKS':
        if (!s.count) return t('sig.OVERDUE_TASKS.none', { total: s.base ?? 0 });
        return t('sig.OVERDUE_TASKS.what', { n: s.count ?? 0, total: s.base ?? 0, oldest: s.oldestDays ?? 0 });
      default:
        return t('sig.SYNC_OVERDUE.what', { date: s.lastSyncAt ? fmtDateTime(s.lastSyncAt) : '—', h: v2 });
    }
  };
  const thresholdUnit = PCT.includes(s.kind) ? '%' : t(`sig.unit.${s.kind}` as Key);
  const dirty = threshold !== String(s.threshold) || (s.limits.windowDays && days !== String(s.windowDays)) || (s.limits.hours && hours !== String(s.hours));

  return (
    <section className={`sig-card sig-${s.state}`} aria-label={t(`ins.alert.${s.kind}` as Key)}>
      <div className="sig-head">
        <b>{t(`ins.alert.${s.kind}` as Key)}</b>
        <Badge tone={TONE[s.state]}>{t(`sig.state.${s.state}` as Key)}</Badge>
      </div>
      <p className="sig-what">{what()}</p>
      <div className="sig-controls">
        <label className="sig-switch">
          <input type="checkbox" checked={tg} disabled={busy || (!canTelegram && !s.telegramOn)} onChange={(e) => { setTg(e.target.checked); void save({ telegram: e.target.checked }); }} />
          <span>{t('sig.telegram')}</span>
        </label>
        <label className="sig-num">
          <span>{t('sig.threshold')}</span>
          <input className="input" type="number" inputMode="decimal" min={s.limits.threshold[0]} max={s.limits.threshold[1]} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          <span className="muted">{thresholdUnit}</span>
        </label>
        {s.limits.windowDays && (
          <label className="sig-num">
            <span>{t(`sig.days.${s.kind}` as Key)}</span>
            <input className="input" type="number" inputMode="numeric" min={s.limits.windowDays[0]} max={s.limits.windowDays[1]} value={days} onChange={(e) => setDays(e.target.value)} />
            <span className="muted">{t('sig.unit.days')}</span>
          </label>
        )}
        {s.limits.hours && (
          <label className="sig-num">
            <span>{t('sig.waiting')}</span>
            <input className="input" type="number" inputMode="numeric" min={s.limits.hours[0]} max={s.limits.hours[1]} value={hours} onChange={(e) => setHours(e.target.value)} />
            <span className="muted">{t('sig.unit.hours')}</span>
          </label>
        )}
        {dirty && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save({ threshold: Number(threshold), ...(s.limits.windowDays ? { windowDays: Number(days) } : {}), ...(s.limits.hours ? { hours: Number(hours) } : {}) })}>
            {t('common.save')}
          </button>
        )}
        {s.link && <Link className={`btn btn-sm${s.state === 'fired' ? ' btn-primary' : ''}`} href={s.link}>{t(`sig.${s.kind}.open` as Key)}</Link>}
      </div>
      {msg && <p className={msg.ok ? 'sig-msg ok' : 'sig-msg err'} role="status">{msg.text}</p>}
      <details className="more-details">
        <summary>{t('sig.how')}</summary>
        <p className="rule">{t(`sig.${s.kind}.how` as Key)}</p>
        {s.state === 'fired' && <p className="rule">{t(`sig.${s.kind}.why` as Key)}</p>}
        <label className="sig-switch">
          <input type="checkbox" checked={em} disabled={busy} onChange={(e) => { setEm(e.target.checked); void save({ enabled: e.target.checked }); }} />
          <span>{t('sig.email')}</span>
        </label>
        {/* Push: only where this device can receive it (the installed app with permission and a subscription) */}
        {pushHere && (
          <label className="sig-switch">
            <input type="checkbox" checked={pu} disabled={busy} onChange={(e) => { setPu(e.target.checked); void save({ push: e.target.checked }); }} />
            <span>{t('sig.push')}</span>
          </label>
        )}
        <p className="muted" style={{ fontSize: 13 }}>
          {s.telegramSentAt ? t('sig.lastTelegram', { date: fmtDateTime(s.telegramSentAt) }) + ' ' : ''}
          {s.lastFiredAt ? t('sig.lastFired', { date: fmtDateTime(s.lastFiredAt) }) : ''}
        </p>
      </details>
    </section>
  );
}
