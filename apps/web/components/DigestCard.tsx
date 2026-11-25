'use client';

import Link from 'next/link';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Key, useI18n } from '../lib/i18n';
import { fmtDateTime } from '../lib/ui';
import { Alert, Badge, Card } from './ui';
import { ProHint } from './ProHint';
import { Switch } from './Switch';
import { useConfirm } from './ConfirmDialog';

interface Digest {
  frequency: 'OFF' | 'DAILY';
  hour: number;
  weekday: number;
  nextAt: string | null;
  // the old rolling weekly digest's own schedule, while it is still on (independent of the daily digest)
  legacy: { on: boolean; weekday: number; hour: number; nextAt: string | null } | null;
  recipients: { id: string; name: string; lang: string }[];
  botConnected: boolean;
  serviceBot: boolean;
}
interface Next { at: string; from: string; to: string }
interface Periods {
  weekly: { on: boolean; weekday: number; hour: number; to: string[]; next: Next };
  monthly: { on: boolean; hour: number; to: string[]; next: Next };
  serviceBot: boolean;
}
interface Leaders { digestTo: string[]; me: { digest: boolean; weekly: boolean; monthly: boolean; legacyWeekly?: boolean; blocked: boolean } | null; available: boolean }
interface Legacy {
  legacy: boolean;
  old: { weekday: number; hour: number; nextAt: string | null } | null;
  weekly: { on: boolean; weekday: number; hour: number; next: Next; othersSubscribed: number };
  me: { connected: boolean; receivesOld: boolean; moved: boolean; weekly: boolean } | null;
  legacyChats: number;
}

const day = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

// Reports → Scheduled → "Reports to managers in Telegram": the three formats in one place, each with its data period, its schedule (Kyiv time),
// whether the CLINIC's schedule is on, whether the signed-in person is subscribed, and what it takes to receive it. The clinic's schedule is set
// here (owner and manager) and is one for everybody; each person subscribes in their own Telegram connection (Settings → General). The old
// rolling 7-day weekly digest can no longer be chosen; where it is still on, it is marked and each person moves from it explicitly.
export function DigestCard() {
  const { t } = useI18n();
  const tk = t as (k: string, v?: Record<string, string | number>) => string;
  const { ask, dialog } = useConfirm();
  const [d, setD] = useState<Digest | null>(null);
  const [p, setP] = useState<Periods | null>(null);
  const [leaders, setLeaders] = useState<Leaders | null>(null);
  const [legacy, setLegacy] = useState<Legacy | null>(null);
  const [move, setMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = useCallback(async () => {
    const [a, b, c, l] = await Promise.all([api<Digest>('/digest'), api<Periods>('/period-reports/settings'), api<Leaders>('/leader-telegram').catch(() => null), api<Legacy>('/period-reports/legacy-weekly').catch(() => null)]);
    setD(a);
    setP(b);
    setLeaders(c);
    setLegacy(l);
  }, []);
  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      await load();
      if (ok) setInfo(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const digest = (body: object) => run(() => api('/digest', { method: 'PATCH', body: JSON.stringify(body) }), t('common.saved'));
  const periods = (body: object) => run(() => api('/period-reports/settings', { method: 'PATCH', body: JSON.stringify(body) }), t('common.saved'));

  if (!d || !p) return error ? <Alert tone="error">{error}</Alert> : null;
  const me = leaders?.me ?? null;
  const oldWeekly = !!d.legacy?.on;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const days = [1, 2, 3, 4, 5, 6, 7];

  // the daily digest and the old weekly one are independent: switching the daily one on or off never touches the old weekly one
  const daily = (on: boolean) => digest({ frequency: on ? 'DAILY' : 'OFF' });
  const mine = (subscribed: boolean | undefined) =>
    !me ? <span className="muted">{t('fmt.meNone')}</span> : me.blocked ? <Badge tone="amber">{t('ltg.blocked')}</Badge> : <Badge tone={subscribed ? 'green' : 'gray'}>{subscribed ? t('fmt.meOn') : t('fmt.meOff')}</Badge>;

  const row = (o: { title: string; period: string; schedule: ReactNode; on: boolean; onToggle: (v: boolean) => void; toggleDisabled?: boolean; me: boolean | undefined; need: string; next: string | null; extra?: ReactNode }) => (
    <div className="fmt-row">
      <div className="fmt-head">
        <h3>{o.title}</h3>
        {mine(o.me)}
      </div>
      <p className="fmt-line"><b>{t('fmt.period')}</b> {o.period}</p>
      <Switch checked={o.on} disabled={busy || o.toggleDisabled} onChange={o.onToggle} label={t('fmt.clinicOn')} hint={o.on && o.next ? t('fmt.next', { at: o.next }) : t('fmt.clinicOff')} />
      {o.on && <div className="toolbar" style={{ alignItems: 'flex-end', marginBottom: 6 }}>{o.schedule}</div>}
      {o.extra}
      <p className="fmt-need">{o.need}</p>
    </div>
  );
  const hourSelect = (value: number, onChange: (h: number) => void) => (
    <label className="field" style={{ margin: 0 }}>
      <span>{t('dg.hour')}</span>
      <select className="select" value={value} disabled={busy} onChange={(e) => onChange(Number(e.target.value))}>
        {hours.map((h) => <option key={h} value={h}>{hh(h)}</option>)}
      </select>
    </label>
  );

  return (
    <Card title={t('fmt.title')}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('fmt.intro')}</p>
      {!d.serviceBot && <Alert tone="info">{t('ltg.offText')}</Alert>}

      {oldWeekly && legacy && (
        <div className="fmt-legacy">
          <Alert tone="warn">
            <b>{t('fmt.legacyTitle')}</b>
            <br />
            {t('fmt.legacyText', { day: tk(`dg.wd${d.legacy!.weekday}`), time: hh(d.legacy!.hour) })}
            {d.legacy!.nextAt ? ` ${t('fmt.legacyNext', { at: fmtDateTime(d.legacy!.nextAt) })}` : ''}
          </Alert>
          {legacy.me?.receivesOld && <button className="btn btn-primary" disabled={busy} onClick={() => setMove(true)}>{t('fmt.moveBtn')}</button>}
          {legacy.me?.moved && <p className="fmt-need">{t('fmt.moved')}</p>}
          {!legacy.me && <p className="fmt-need">{t('fmt.legacyConnect')} <Link href="/settings#leader-telegram">{t('ltg.connect')}</Link></p>}
          {legacy.legacyChats > 0 && <p className="fmt-need">{t('fmt.legacyChats', { n: legacy.legacyChats })}</p>}
        </div>
      )}

      <ProHint feature="daily_digest" />
      {row({
        title: t('fmt.daily'),
        period: t('fmt.dailyPeriod'),
        on: d.frequency === 'DAILY',
        onToggle: (v) => void daily(v),
        me: me?.digest,
        need: t('fmt.dailyNeed'),
        next: d.frequency === 'DAILY' && d.nextAt ? fmtDateTime(d.nextAt) : null,
        schedule: hourSelect(d.hour, (h) => void digest({ hour: h })),
      })}
      {row({
        title: t('pr.weekly'),
        period: t('fmt.weeklyPeriod'),
        on: p.weekly.on,
        onToggle: (v) => void periods({ weeklyOn: v }),
        me: me?.weekly,
        need: t('fmt.reportNeed'),
        next: t('fmt.nextFor', { at: fmtDateTime(p.weekly.next.at), period: `${day(p.weekly.next.from)} — ${day(p.weekly.next.to)}` }),
        schedule: (
          <>
            <label className="field" style={{ margin: 0 }}>
              <span>{t('dg.weekday')}</span>
              <select className="select" value={p.weekly.weekday} disabled={busy} onChange={(e) => void periods({ weeklyWeekday: Number(e.target.value) })}>
                {days.map((n) => <option key={n} value={n}>{tk(`dg.wd${n}`)}</option>)}
              </select>
            </label>
            {hourSelect(p.weekly.hour, (h) => void periods({ weeklyHour: h }))}
          </>
        ),
      })}
      {row({
        title: t('pr.monthly'),
        period: t('fmt.monthlyPeriod'),
        on: p.monthly.on,
        onToggle: (v) => void periods({ monthlyOn: v }),
        me: me?.monthly,
        need: t('fmt.reportNeed'),
        next: t('fmt.nextFor', { at: fmtDateTime(p.monthly.next.at), period: `${day(p.monthly.next.from)} — ${day(p.monthly.next.to)}` }),
        schedule: hourSelect(p.monthly.hour, (h) => void periods({ monthlyHour: h })),
      })}

      {d.recipients.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, margin: '16px 0 6px' }}>{t('dg.recipients')}</h3>
          <p className="rule" style={{ margin: '0 0 6px' }}>{t('dg.legacy')}</p>
          {d.recipients.map((r) => (
            <div key={r.id} className="toolbar" style={{ marginBottom: 6 }}>
              <span className="grow"><b>{r.name}</b> <Badge tone="amber">{t('dg.legacyBadge')}</Badge></span>
              <button className="btn btn-sm" disabled={busy} onClick={async () => (await ask(t('dg.removeConfirm', { name: r.name }), { danger: true, confirmLabel: t('common.delete') })) && run(() => api(`/digest/recipients/${r.id}`, { method: 'DELETE' }))}>
                {t('common.delete')}
              </button>
            </div>
          ))}
        </>
      )}
      <div className="toolbar" style={{ marginTop: 10 }}>
        <Link className="btn btn-sm btn-primary" href="/settings#leader-telegram">{me ? t('dg.mySettings') : t('ltg.connect')}</Link>
        <Link className="btn btn-sm" href="/period-report">{t('pr.openPreview')}</Link>
        {(d.frequency !== 'OFF' || oldWeekly) && (leaders?.digestTo.length || d.recipients.length) ? (
          <button className="btn btn-sm" disabled={busy} onClick={() => run(async () => { const r = await api<{ sent: number }>('/digest/test', { method: 'POST' }); if (!r.sent) throw new Error(t('dg.testFail')); }, t('dg.testOk'))}>{t('dg.test')}</button>
        ) : null}
      </div>
      {move && legacy && <MoveDialog legacy={legacy} busy={busy} onClose={() => setMove(false)} onConfirm={() => run(async () => { await api('/period-reports/legacy-weekly/move', { method: 'POST', body: JSON.stringify({ enableSchedule: !legacy.weekly.on }) }); setMove(false); }, t('fmt.movedOk'))} />}
    </Card>
  );
}

// The move, explained before it happens: the period changes from "the last 7 days" to the completed Monday–Sunday week, the next sending, the
// weekly schedule that will be used (its own, or switched on for the clinic), and that only this person's subscription changes
function MoveDialog({ legacy, busy, onClose, onConfirm }: { legacy: Legacy; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const { t } = useI18n();
  const tk = t as (k: Key | string, v?: Record<string, string | number>) => string;
  const w = legacy.weekly;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="mv-title" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2 id="mv-title">{t('fmt.moveTitle')}</h2>
          <button type="button" className="btn btn-sm modal-close" aria-label={t('prof.close')} onClick={onClose}>✕</button>
        </div>
        <ul className="rule" style={{ paddingLeft: 20 }}>
          <li>{t('fmt.movePeriod')}</li>
          {legacy.old && <li>{t('fmt.moveWas', { day: tk(`dg.wd${legacy.old.weekday}`), time: hh(legacy.old.hour) })}</li>}
          <li>{t('fmt.moveWill', { day: tk(`dg.wd${w.weekday}`), time: hh(w.hour) })}</li>
          <li>{t('fmt.moveNext', { at: fmtDateTime(w.next.at), period: `${day(w.next.from)} — ${day(w.next.to)}` })}</li>
          {/* switching the clinic's weekly schedule on also resumes the report for the people already subscribed to it: said, not hidden */}
          {!w.on && <li><b>{w.othersSubscribed ? t('fmt.moveScheduleOthers', { n: w.othersSubscribed }) : t('fmt.moveSchedule')}</b></li>}
          <li>{t('fmt.moveOnlyMe')}</li>
        </ul>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={busy} onClick={onConfirm}>{t('fmt.moveConfirm')}</button>
        </div>
      </div>
    </div>
  );
}
