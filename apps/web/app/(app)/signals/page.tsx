'use client';

import Link from 'next/link';
import { Fragment, ReactNode, useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Key, useI18n } from '../../../lib/i18n';
import { fmtDate, fmtDateTime } from '../../../lib/ui';
import { Alert, Badge, Loading, PageHeader } from '../../../components/ui';
import { ProHint } from '../../../components/ProHint';
import { usePushDevice } from '../../../components/PushCard';

type State = 'fired' | 'ok' | 'insufficient' | 'needs_sync' | 'never' | 'not_connected' | 'off';
type Kind = 'CANCEL_RATE' | 'NO_REBOOK' | 'OVERDUE_TASKS' | 'PAYMENTS_DROP' | 'RETURN_DROP' | 'STALE_REQUESTS' | 'SYNC_OVERDUE' | 'UNFINISHED_NO_NEXT';
interface Signal {
  kind: Kind;
  state: State;
  // the master switch (off: not measured, nothing delivered on any channel; the channel preferences are kept)
  active: boolean;
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

const TONE: Record<State, 'red' | 'green' | 'gray' | 'amber'> = { fired: 'red', ok: 'green', insufficient: 'gray', needs_sync: 'amber', never: 'amber', not_connected: 'gray', off: 'gray' };
// switched-on triggered signals first, then the other switched-on ones, the switched-off ones last
const ORDER: State[] = ['fired', 'ok', 'insufficient', 'needs_sync', 'never', 'not_connected', 'off'];
const PCT: Kind[] = ['CANCEL_RATE', 'RETURN_DROP', 'PAYMENTS_DROP'];
// "**x**" in a translated sentence marks the number that matters
const rich = (text: string): ReactNode => text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : <Fragment key={i}>{part}</Fragment>));
// a period's end is exclusive (the start of the next day): show the last day it covers
const lastDay = (iso: string) => fmtDate(new Date(Date.parse(iso) - 1).toISOString());

// Reports → "Signals": deviations in the clinic's work measured now from its own data (GET /signals), with each signal's settings: the master
// switch, the condition written as a sentence with its numbers, delivery to the staff Telegram chat and (under the details) email and Push.
// Saving sends nothing. The order is fixed when the page loads, so a card does not jump while it is being edited.
export default function SignalsPage() {
  const { t } = useI18n();
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [order, setOrder] = useState<Kind[] | null>(null);
  // Push on this device: only in the installed app; a browser tab shows no Push controls (the saved preferences stay)
  const device = usePushDevice();
  const load = useCallback(() => {
    setError('');
    return api<View>('/signals')
      .then((r) => {
        setV(r);
        setOrder((o) => o ?? [...r.signals].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state)).map((x) => x.kind));
      })
      .catch((e) => setError((e as Error).message));
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

  const rank = (k: Kind) => (order ?? []).indexOf(k);
  const list = [...v.signals].sort((a, b) => rank(a.kind) - rank(b.kind));
  // the summary counts only the signals that are switched on
  const on = list.filter((s) => s.active);
  const fired = on.filter((s) => s.state === 'fired').length;
  const measured = on.filter((s) => s.state === 'fired' || s.state === 'ok').length;

  return (
    <>
      {header}
      {v.sync && v.sync.connected && !v.sync.fresh && (
        <Alert tone="warn">
          {v.sync.lastSyncAt ? t('sig.syncOld', { date: fmtDateTime(v.sync.lastSyncAt) }) : t('sig.syncNever')} <Link href="/settings">{t('sig.toSync')}</Link>
        </Alert>
      )}
      {on.length === 0 ? (
        <Alert tone="info">{t('sig.summaryAllOff')}</Alert>
      ) : fired > 0 ? (
        <Alert tone="warn">{t('sig.summaryFired', { n: fired })}</Alert>
      ) : measured === on.length ? (
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
        {list.map((s) => <SignalCard key={s.kind} s={s} chat={v.telegram?.title ?? null} pushHere={device.state === 'active'} onSaved={load} />)}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>{t('sig.checkedAt', { date: fmtDateTime(v.checkedAt) })}</p>
    </>
  );
}

function SignalCard({ s, chat, pushHere, onSaved }: { s: Signal; chat: string | null; pushHere: boolean; onSaved: () => Promise<unknown> }) {
  const { t } = useI18n();
  const [threshold, setThreshold] = useState(String(s.threshold));
  const [days, setDays] = useState(String(s.windowDays));
  const [hours, setHours] = useState(String(s.hours));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // the switches answer at once; a failed save puts them back
  const [on, setOn] = useState(s.active);
  const [tg, setTg] = useState(s.telegramOn);
  const [em, setEm] = useState(s.emailOn);
  const [pu, setPu] = useState(s.pushOn);
  useEffect(() => {
    setOn(s.active);
    setTg(s.telegramOn);
    setEm(s.emailOn);
    setPu(s.pushOn);
  }, [s.active, s.telegramOn, s.emailOn, s.pushOn]);
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
      setOn(s.active);
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
  // the current result in one short sentence (the number that matters in bold); dates and secondary numbers go to the details
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
        return t('sig.CANCEL_RATE.what', { v: v2, n: s.count ?? 0, total: s.base ?? 0 });
      case 'RETURN_DROP':
        return t(`sig.RETURN_DROP.${dir}` as Key, { cur: s.count ?? 0, prev: s.base ?? 0, v: Math.abs(v2) });
      case 'PAYMENTS_DROP':
        return t(`sig.PAYMENTS_DROP.${dir}` as Key, { cur: (s.amount ?? 0).toLocaleString(), prev: (s.prevAmount ?? 0).toLocaleString(), u: unit(s.currency), v: Math.abs(v2) });
      case 'STALE_REQUESTS':
        return t('sig.STALE_REQUESTS.what', { n: s.count ?? 0, h: s.hours, total: s.base ?? 0 });
      case 'UNFINISHED_NO_NEXT':
        if (!s.count) return t('sig.UNFINISHED_NO_NEXT.none', { d: s.windowDays, total: s.base ?? 0 });
        return t('sig.UNFINISHED_NO_NEXT.what', { n: s.count ?? 0, d: s.windowDays, total: s.base ?? 0 });
      case 'NO_REBOOK':
        return t('sig.NO_REBOOK.what', { n: s.count ?? 0, total: s.base ?? 0 });
      case 'OVERDUE_TASKS':
        if (!s.count) return t('sig.OVERDUE_TASKS.none', { total: s.base ?? 0 });
        return t('sig.OVERDUE_TASKS.what', { n: s.count ?? 0, total: s.base ?? 0 });
      default:
        return t('sig.SYNC_OVERDUE.what', { date: s.lastSyncAt ? fmtDateTime(s.lastSyncAt) : '—', h: v2 });
    }
  };
  // the dates and secondary numbers of a measured signal (shown under the details)
  const details = (): string[] => {
    if (s.state !== 'fired' && s.state !== 'ok') return [];
    if (s.kind === 'RETURN_DROP' || s.kind === 'PAYMENTS_DROP') return [t('sig.detail.compare', { period: period(s.from, s.to), prevPeriod: period(s.prevFrom, s.prevTo) })];
    if (s.kind === 'CANCEL_RATE') return [t('sig.detail.period', { period: period(s.from, s.to) })];
    if (s.kind === 'NO_REBOOK') return [t('sig.detail.missed', { period: period(s.from, s.to) })];
    if (s.kind === 'UNFINISHED_NO_NEXT' && s.count) return [t('sig.detail.oldestPatient', { n: s.oldestDays ?? 0 })];
    if (s.kind === 'OVERDUE_TASKS' && s.count) return [t('sig.detail.oldestTask', { n: s.oldestDays ?? 0 })];
    return [];
  };
  const dirty = threshold !== String(s.threshold) || (s.limits.windowDays && days !== String(s.windowDays)) || (s.limits.hours && hours !== String(s.hours));
  const title = t(`ins.alert.${s.kind}` as Key);
  const num = (value: string, set: (v: string) => void, [lo, hi]: [number, number], label: string, decimal = false) => (
    <input className="input sig-inline" type="number" inputMode={decimal ? 'decimal' : 'numeric'} min={lo} max={hi} value={value} aria-label={label} onChange={(e) => set(e.target.value)} />
  );
  // the condition as a sentence, with the numbers that can be changed in place
  const condition = t(`sig.${s.kind}.cond` as Key)
    .split(/(\{threshold\}|\{days\}|\{hours\})/)
    .map((part, i) => {
      if (part === '{threshold}') return <Fragment key={i}>{num(threshold, setThreshold, s.limits.threshold, title, PCT.includes(s.kind))}</Fragment>;
      if (part === '{days}' && s.limits.windowDays) return <Fragment key={i}>{num(days, setDays, s.limits.windowDays, title)}</Fragment>;
      if (part === '{hours}' && s.limits.hours) return <Fragment key={i}>{num(hours, setHours, s.limits.hours, title)}</Fragment>;
      return <Fragment key={i}>{part}</Fragment>;
    });

  return (
    <section className={`sig-card sig-${s.state}`} aria-label={title}>
      <div className="sig-head">
        <b className="sig-title">{title}</b>
        <label className="sig-switch sig-master">
          <input type="checkbox" checked={on} disabled={busy} onChange={(e) => { setOn(e.target.checked); void save({ active: e.target.checked }); }} />
          <span>{t('sig.active')}</span>
        </label>
      </div>
      <div className="sig-now">
        <Badge tone={TONE[s.state]}>{t(`sig.state.${s.state}` as Key)}</Badge>
        <p className="sig-what">{s.active ? rich(what()) : t('sig.offNote')}</p>
      </div>
      <div className="sig-cond">
        <p>{condition}</p>
        {dirty && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save({ threshold: Number(threshold), ...(s.limits.windowDays ? { windowDays: Number(days) } : {}), ...(s.limits.hours ? { hours: Number(hours) } : {}) })}>
            {t('common.save')}
          </button>
        )}
      </div>
      <div className="sig-tg">
        <label className="sig-switch">
          <input type="checkbox" checked={tg} disabled={busy || !on || (!chat && !s.telegramOn)} onChange={(e) => { setTg(e.target.checked); void save({ telegram: e.target.checked }); }} />
          <span>{t('sig.telegram')}</span>
        </label>
        {chat ? <span className="muted">{t('sig.telegramTo', { title: chat })}</span> : <span className="muted">{t('sig.telegramNone')} <Link href="/settings?tab=channels">{t('sig.destConnect')}</Link></span>}
      </div>
      {msg && <p className={msg.ok ? 'sig-msg ok' : 'sig-msg err'} role="status">{msg.text}</p>}
      {s.link && s.active && <Link className={`btn btn-sm${s.state === 'fired' ? ' btn-primary' : ''}`} href={s.link}>{t(`sig.${s.kind}.open` as Key)}</Link>}
      <details className="more-details">
        <summary>{t('sig.how')}</summary>
        {details().map((d) => <p key={d} className="rule">{d}</p>)}
        <p className="rule">{t(`sig.${s.kind}.how` as Key)}</p>
        {s.state === 'fired' && <p className="rule">{t(`sig.${s.kind}.why` as Key)}</p>}
        <p className="sig-sub">{t('sig.channels')}</p>
        <label className="sig-switch">
          <input type="checkbox" checked={em} disabled={busy || !on} onChange={(e) => { setEm(e.target.checked); void save({ enabled: e.target.checked }); }} />
          <span>{t('sig.email')}</span>
        </label>
        {/* Push: only where this device can receive it (the installed app with permission and a subscription) */}
        {pushHere && (
          <label className="sig-switch">
            <input type="checkbox" checked={pu} disabled={busy || !on} onChange={(e) => { setPu(e.target.checked); void save({ push: e.target.checked }); }} />
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
