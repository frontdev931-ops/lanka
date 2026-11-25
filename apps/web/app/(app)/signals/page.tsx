'use client';

import Link from 'next/link';
import { Fragment, ReactNode, useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Key, useI18n } from '../../../lib/i18n';
import { fmtDateTime } from '../../../lib/ui';
import { Alert, Loading, PageHeader } from '../../../components/ui';
import { Kind, rich, Signal, signalText, State } from '../../../components/signalText';
import { ProHint } from '../../../components/ProHint';
import { usePushDevice } from '../../../lib/push-device';
import { SignalClinic } from '../../../components/SignalClinic';

interface View {
  inPlan: boolean;
  checkedAt: string;
  sync: { lastSyncAt: string | null; fresh: boolean; connected: boolean } | null;
  // who a rule's Telegram switch reaches: managers through the LANKA service bot (each by their own choice) and the legacy staff group of the
  // clinic's patient bot; me: the signed-in person's own connection (null: not connected)
  telegram: { serviceBot: boolean; people: string[]; group: string | null; me: { signals: boolean; blocked: boolean } | null };
  signals: Signal[];
}

// switched-on triggered signals first, then the other switched-on ones, the switched-off ones last
const ORDER: State[] = ['fired', 'ok', 'insufficient', 'needs_sync', 'never', 'not_connected', 'off'];
// The summary: switched-on signals by what they show now; "not measured" = too little data, a load is needed, or Cliniccards is not connected
const COUNTS: { key: 'fired' | 'ok' | 'pending' | 'off'; tone: State; states: State[] }[] = [
  { key: 'fired', tone: 'fired', states: ['fired'] },
  { key: 'ok', tone: 'ok', states: ['ok'] },
  { key: 'pending', tone: 'insufficient', states: ['insufficient', 'needs_sync', 'never', 'not_connected'] },
  { key: 'off', tone: 'off', states: [] },
];
const PCT: Kind[] = ['CANCEL_RATE', 'RETURN_DROP', 'PAYMENTS_DROP'];
// rules whose details list the very patients the rule counted
const PATIENT_KINDS: Kind[] = ['NO_REBOOK', 'UNFINISHED_NO_NEXT'];

// "Signals" (its own menu item since 2026-11-23): deviations in the clinic's work measured now from its own data (GET /signals), with each signal's settings: the master
// switch, the condition written as a sentence with its numbers, delivery to the staff Telegram chat and (under the details) email and Push.
// Saving sends nothing. The order is fixed when the page loads, so a card does not jump while it is being edited.
export default function SignalsPage() {
  return (
    <SignalClinic>
      <Signals />
    </SignalClinic>
  );
}

function Signals() {
  const { t, locale } = useI18n();
  const [overview, setOverview] = useState(false);
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [order, setOrder] = useState<Kind[] | null>(null);
  // Push on this device: only in the installed app; a browser tab shows no Push controls (the saved preferences stay)
  const device = usePushDevice(locale);
  const load = useCallback(() => {
    setError('');
    return api<View>('/signals')
      .then((r) => {
        setV(r);
        setOrder((o) => o ?? [...r.signals].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state)).map((x) => x.kind));
        // the menu badge asks its summary again: the server has just measured, so it answers from this measurement
        window.dispatchEvent(new Event('stomat:signals-changed'));
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const header = <PageHeader title={t('sig.title')} subtitle={t('sig.subtitle')} actions={v?.inPlan ? <button className="btn" onClick={() => setOverview(true)}>{t('sigo.open')}</button> : undefined} />;
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
  // how many receive a rule's Telegram message now: the managers who chose signals, plus the legacy group
  const reach = v.telegram.people.length + (v.telegram.group ? 1 : 0);
  const list = [...v.signals].sort((a, b) => rank(a.kind) - rank(b.kind));
  // the summary counts only the signals that are switched on
  const on = list.filter((s) => s.active);

  return (
    <>
      {header}
      {v.sync && v.sync.connected && !v.sync.fresh && (
        <Alert tone="warn">
          {v.sync.lastSyncAt ? t('sig.syncOld', { date: fmtDateTime(v.sync.lastSyncAt) }) : t('sig.syncNever')} <Link href="/settings">{t('sig.toSync')}</Link>
        </Alert>
      )}
      <section className="sig-summary" aria-label={t('sig.summary')}>
        <div className="sig-counts">
          {COUNTS.map((c) => {
            const n = on.filter((x) => c.states.includes(x.state)).length + (c.key === 'off' ? list.length - on.length : 0);
            return (
              <div key={c.key} className={`sig-count${c.key === 'fired' && n > 0 ? ' hot' : ''}`}>
                <span className={`sig-count-icon st-${c.tone}`} aria-hidden="true"><StateIcon state={c.tone} size={18} /></span>
                <span><b>{n}</b><span className="l">{t(`sig.cnt.${c.key}` as Key)}</span></span>
              </div>
            );
          })}
        </div>
        <p className="sig-dest">
          <span className="sig-dest-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></svg></span>
          <span className="t">
            {reach ? t('sig.destTo', { list: [v.telegram.people.length ? t('sig.destPeople', { names: v.telegram.people.join(', ') }) : '', v.telegram.group ? t('sig.destGroup', { title: v.telegram.group }) : ''].filter(Boolean).join('; ') }) : t('sig.destNobody')}{' '}
            {v.telegram.me ? (v.telegram.me.signals ? t('sig.meOn') : t('sig.meOff')) : t('sig.meNone')}
          </span>
          <Link href="/settings#leader-telegram">{v.telegram.me ? t('sig.mySettings') : t('ltg.connect')}</Link>
        </p>
      </section>
      {/* Push of this device is set up in Settings → General → Push (the permission is asked only there, on a click) */}
      {(device.state === 'off' || device.state === 'granted_no_server') && (
        <Alert tone="info">
          {t('sig.pushAsk')} <Link href="/settings#push">{t('sig.pushEnable')}</Link>
        </Alert>
      )}
      {device.state === 'denied' && <Alert tone="warn">{t('sig.pushDenied')} <Link href="/settings#push">{t('pushd.title')}</Link></Alert>}
      <div className="signal-list">
        {list.map((s) => <SignalCard key={s.kind} s={s} reach={reach} pushHere={device.state === 'on'} onSaved={load} />)}
      </div>
      <p className="sig-foot">{t('sig.checkedAt', { date: fmtDateTime(v.checkedAt) })}</p>
      {overview && <OverviewDialog me={v.telegram.me} onClose={() => setOverview(false)} />}
    </>
  );
}

function SignalCard({ s, reach, pushHere, onSaved }: { s: Signal; reach: number; pushHere: boolean; onSaved: () => Promise<unknown> }) {
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

  const { what, details } = signalText(s, t);
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

  const toggle = (checked: boolean, disabled: boolean, onClick: () => void, label: ReactNode, note?: ReactNode, aria?: string) => (
    <button type="button" className="tgl" role="switch" aria-checked={checked} aria-label={aria} disabled={disabled} onClick={onClick}>
      <span className="tgl-track" aria-hidden="true" />
      <span className="tgl-text"><b>{label}</b>{note && <span>{note}</span>}</span>
    </button>
  );

  return (
    <section className={`sig-card sig-${s.state}`} aria-label={title}>
      <div className="sig-top">
        <div>
          <span className={`sig-status st-${s.state}`}><StateIcon state={s.state} size={14} />{t(`sig.state.${s.state}` as Key)}</span>
          <h2 className="sig-title">{title}</h2>
        </div>
        <button type="button" className="tgl tgl-master" role="switch" aria-checked={on} aria-label={`${t('sig.active')}: ${title}`} disabled={busy} onClick={() => { setOn(!on); void save({ active: !on }); }}>
          <span>{on ? t('sig.onShort') : t('sig.state.off')}</span>
          <span className="tgl-track" aria-hidden="true" />
        </button>
      </div>
      <p className="sig-what">{s.active ? rich(what()) : t('sig.offNote')}</p>
      <div className="sig-cond">
        <p>{condition}</p>
        {dirty && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save({ threshold: Number(threshold), ...(s.limits.windowDays ? { windowDays: Number(days) } : {}), ...(s.limits.hours ? { hours: Number(hours) } : {}) })}>
            {t('common.save')}
          </button>
        )}
      </div>
      <div className="sig-actions">
        {toggle(tg, busy || !on, () => { setTg(!tg); void save({ telegram: !tg }); }, t('sig.telegram'), !on ? t('sig.enableFirst') : reach ? t('sig.tgReach', { n: reach }) : t('sig.tgNobody'))}
        <span className="grow" />
        {s.active && (
          <Link className="sig-link" href={`/signals/${s.kind}`}>
            {t(PATIENT_KINDS.includes(s.kind) ? 'sigd.patients' : 'sigd.open')}
          </Link>
        )}
        {s.link && s.active && !PATIENT_KINDS.includes(s.kind) && (
          <Link className="sig-link" href={s.link}>
            {t(`sig.${s.kind}.open` as Key)}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </Link>
        )}
      </div>
      {msg && <p className={msg.ok ? 'sig-msg ok' : 'sig-msg err'} role="status">{msg.text}</p>}
      <details className="sig-how">
        <summary>
          {t('sig.how')}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </summary>
        <div className="sig-how-body">
          {details().map((d) => <p key={d}>{d}</p>)}
          <p>{t(`sig.${s.kind}.how` as Key)}</p>
          {s.state === 'fired' && <p>{t(`sig.${s.kind}.why` as Key)}</p>}
          <p className="sig-sub">{t('sig.channels')}</p>
          {toggle(em, busy || !on, () => { setEm(!em); void save({ enabled: !em }); }, t('sig.email'))}
          {/* Push: only where this device can receive it (the installed app with permission and a subscription) */}
          {pushHere && toggle(pu, busy || !on, () => { setPu(!pu); void save({ push: !pu }); }, t('sig.push'))}
          {(s.telegramSentAt || s.lastFiredAt) && (
            <p style={{ fontSize: 13 }}>
              {s.telegramSentAt ? t('sig.lastTelegram', { date: fmtDateTime(s.telegramSentAt) }) + ' ' : ''}
              {s.lastFiredAt ? t('sig.lastFired', { date: fmtDateTime(s.lastFiredAt) }) : ''}
            </p>
          )}
        </div>
      </details>
    </section>
  );
}

// The state mark: an icon next to the word, so a state never depends on its colour alone
const STATE_ICON: Record<State, string> = {
  fired: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  ok: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
  insufficient: 'M6 2h12M6 22h12M7 2c0 6 5 6 5 10s-5 4-5 10M17 2c0 6-5 6-5 10s5 4 5 10',
  needs_sync: 'M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2M18 2v4h-4M6 22v-4h4',
  never: 'M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2M18 2v4h-4M6 22v-4h4',
  not_connected: 'M9 7H6a5 5 0 0 0 0 10h3M15 7h3a5 5 0 0 1 0 10h-3M3 3l18 18',
  off: 'M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10',
};
function StateIcon({ state, size }: { state: State; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={STATE_ICON[state]} /></svg>
  );
}

// "Current state of signals": a preview of the text (GET /signals/overview, sends nothing); sending it to one's own LANKA service-bot chat is a
// separate explicit button, only for a connected, not blocked Telegram (the server checks the connection and the role again)
function OverviewDialog({ me, onClose }: { me: { signals: boolean; blocked: boolean } | null; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    api<{ inPlan: boolean; text?: string }>(`/signals/overview?lang=${locale}`)
      .then((r) => setText(r.text ?? ''))
      .catch((e) => setError((e as Error).message));
  }, [locale]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const send = async () => {
    setBusy(true);
    setSent(null);
    try {
      await api('/signals/overview/send', { method: 'POST', body: JSON.stringify({ lang: locale }) });
      setSent({ ok: true, text: t('sigo.sent') });
    } catch (e) {
      setSent({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const canSend = !!me && !me.blocked;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sigo-title" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2 id="sigo-title">{t('sigo.title')}</h2>
          <button type="button" className="btn btn-sm modal-close" aria-label={t('prof.close')} onClick={onClose}>✕</button>
        </div>
        <p className="rule">{t('sigo.hint')}</p>
        {error ? <Alert tone="error">{error}</Alert> : text === null ? <Loading /> : <pre className="sigo-text">{text}</pre>}
        {sent && <p className={sent.ok ? 'sig-msg ok' : 'sig-msg err'} role="status">{sent.text}</p>}
        <div className="modal-actions">
          {canSend ? (
            <button className="btn btn-primary" disabled={busy || !text} onClick={() => void send()}>{t('sigo.send')}</button>
          ) : (
            <Link className="btn" href="/settings#leader-telegram">{me?.blocked ? t('sigo.blocked') : t('sigo.connect')}</Link>
          )}
        </div>
      </div>
    </div>
  );
}
