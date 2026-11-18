'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { fmtDateTime } from '../../lib/ui';
import { Alert, Icon, PageHeader } from '../../components/ui';
import { OnboardingCard } from '../../components/OnboardingCard';
import { Period, PRESET_DAYS, dayLabel, localDay, periodQuery, rangeProblem, readPeriod, today } from '../../lib/period';

interface Report {
  dataUpdatedAt: string | null;
  rows: unknown[];
}
interface Summary {
  open: number;
  overdue: number;
  doneToday: number;
}
interface Integration {
  mode: 'demo' | 'cliniccards';
  lastSyncAt: string | null;
}

// The period of the report cards (one choice for all of them, remembered in the browser): yesterday, 7, 30, 90 days, or any range picked in the
// calendar. The cards of "needs action now" show what waits today and have no period.
const PERIOD_KEY = 'stomat_dash_period';

export default function Dashboard() {
  const t = useT();
  const [noNext, setNoNext] = useState<Report | null>(null);
  const [missed, setMissed] = useState<Report | null>(null);
  const [unclosed, setUnclosed] = useState<Report | null>(null);
  const [tasks, setTasks] = useState<Summary | null>(null);
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [period, setPeriod] = useState<Period>({ kind: 'days', n: 30 });
  // the range form: open, and its two dates
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  // appointments that followed our messages in the period (owner and manager; another role gets no card)
  const [payback, setPayback] = useState<{ booked: number; attended: number } | null>(null);
  const [ready, setReady] = useState(false);
  const q = periodQuery(period);
  // what waits for a person in the messaging: new requests from conversations and messages to approve (a role without access gets no card)
  const [requests, setRequests] = useState<number | null>(null);
  const [toApprove, setToApprove] = useState<number | null>(null);

  useEffect(() => {
    api<Summary>('/tasks/summary').then(setTasks).catch(() => {});
    api<Integration>('/integrations/cliniccards').then(setIntegration).catch(() => {});
    api<{ newCount: number }>('/requests?status=NEW').then((r) => setRequests(r.newCount)).catch(() => {});
    api<{ queue: Record<string, number> }>('/automations').then((r) => setToApprove(r.queue.PENDING_APPROVAL ?? 0)).catch(() => {});
  }, []);

  useEffect(() => {
    try {
      const saved = readPeriod(window.localStorage.getItem(PERIOD_KEY) ?? window.localStorage.getItem('stomat_dash_days'));
      if (saved) setPeriod(saved);
    } catch {
      // the browser forbids storage: the default period stays
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    setNoNext(null);
    setMissed(null);
    setUnclosed(null);
    api<Report>(`/reports/no-next-visit?${q}`).then(setNoNext).catch(() => {});
    api<Report>(`/reports/missed-visits?${q}`).then(setMissed).catch(() => {});
    api<Report>(`/reports/unclosed-visits?${q}`).then(setUnclosed).catch(() => {});
    setPayback(null);
    api<{ booked: number; attended: number }>(`/messages/payback?${q}`).then(setPayback).catch(() => {});
  }, [q, ready]);
  const pick = (p: Period) => {
    setPeriod(p);
    setCustom(null);
    try {
      window.localStorage.setItem(PERIOD_KEY, JSON.stringify(p));
    } catch {
      // not remembered, the choice still works for this visit
    }
  };
  const problem = custom ? rangeProblem(custom.from, custom.to) : null;
  // how the period reads under a figure: "останні 30 днів", "вчора", "01.11.2026 — 10.11.2026"
  const periodText =
    period.kind === 'days' ? t('dash.pLast', { n: period.n }) : period.kind === 'yesterday' ? t('dash.pYesterday') : period.from === period.to ? dayLabel(period.from) : `${dayLabel(period.from)} — ${dayLabel(period.to)}`;

  const updated = noNext?.dataUpdatedAt ? fmtDateTime(noNext.dataUpdatedAt) : t('common.neverSynced');

  return (
    <>
      <PageHeader title={t('dash.title')} subtitle={t('dash.updated', { date: updated })} />
      <OnboardingCard />

      {/* What to show in an empty workspace: demo data, an empty clinic without a connection, or a connected one that is not loaded yet */}
      {integration?.mode === 'demo' && integration.lastSyncAt && (
        <Alert tone="warn">
          {t('dash.demo1')}
          <Link href="/settings">{t('dash.demoLink')}</Link>
          {t('dash.demo2')}
        </Alert>
      )}
      {integration?.mode === 'demo' && !integration.lastSyncAt && (
        <Alert tone="info">
          {t('dash.noData1')}
          <Link href="/settings">{t('dash.demoLink')}</Link>
          {t('dash.noData2')}
        </Alert>
      )}
      {integration?.mode === 'cliniccards' && !integration.lastSyncAt && (
        <Alert tone="info">
          {t('dash.notLoaded1')}
          <Link href="/settings">{t('int.loadData')}</Link>
        </Alert>
      )}

      <div className="dash-head">
        <h2 className="section-title" style={{ margin: 0 }}>{t('dash.periodTitle')}</h2>
        <div className="toolbar" role="group" aria-label={t('dash.periodLabel')}>
          <button type="button" className={period.kind === 'yesterday' ? 'btn btn-sm btn-primary' : 'btn btn-sm'} aria-pressed={period.kind === 'yesterday'} onClick={() => pick({ kind: 'yesterday' })}>{t('dash.yesterday')}</button>
          {PRESET_DAYS.map((d) => {
            const on = period.kind === 'days' && period.n === d;
            return <button key={d} type="button" className={on ? 'btn btn-sm btn-primary' : 'btn btn-sm'} aria-pressed={on} onClick={() => pick({ kind: 'days', n: d })}>{t('dash.days', { n: d })}</button>;
          })}
          <button
            type="button"
            className={period.kind === 'range' || custom ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
            aria-pressed={period.kind === 'range'}
            aria-expanded={!!custom}
            onClick={() => setCustom(custom ? null : period.kind === 'range' ? { from: period.from, to: period.to } : { from: localDay(new Date(Date.now() - 6 * 86_400_000)), to: today() })}
          >
            <Icon name="calendar" size={15} /> {period.kind === 'range' ? periodText : t('dash.custom')}
          </button>
        </div>
      </div>
      {custom && (
        <div className="card dash-range">
          <label className="inline-label">
            {t('dash.from')}
            <input className="input" type="date" value={custom.from} max={custom.to || today()} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
          </label>
          <label className="inline-label">
            {t('dash.to')}
            <input className="input" type="date" value={custom.to} min={custom.from || undefined} max={today()} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </label>
          <div className="toolbar">
            <button type="button" className="btn btn-primary" disabled={!!problem} onClick={() => pick({ kind: 'range', from: custom.from, to: custom.to })}>{t('dash.apply')}</button>
            <button type="button" className="btn" onClick={() => setCustom(null)}>{t('common.cancel')}</button>
          </div>
          {problem && problem !== 'empty' && <p className="muted" style={{ margin: 0, fontSize: 13, flexBasis: '100%' }}>{t(`dash.bad.${problem}`)}</p>}
        </div>
      )}
      <div className="stats">
        <section className="card stat">
          <div className="stat-top">
            {t('dash.noNext')}
            <span className="stat-icon"><Icon name="calendar" /></span>
          </div>
          <div className="stat-value">{noNext ? noNext.rows.length : '—'}</div>
          <div className="stat-foot">
            {t('dash.noNextP', { p: periodText })}
            <Link href={`/reports?report=no-next-visit&${q}`}>{t('common.open')} →</Link>
          </div>
        </section>

        <section className="card stat">
          <div className="stat-top">
            {t('dash.missed')}
            <span className="stat-icon amber"><Icon name="userx" /></span>
          </div>
          <div className="stat-value">{missed ? missed.rows.length : '—'}</div>
          <div className="stat-foot">
            {t('dash.periodP', { p: periodText })}
            <Link href={`/reports?report=missed-visits&${q}`}>{t('common.open')} →</Link>
          </div>
        </section>

        <section className="card stat">
          <div className="stat-top">
            {t('dash.unclosed')}
            <span className="stat-icon amber"><Icon name="clock" /></span>
          </div>
          <div className="stat-value">{unclosed ? unclosed.rows.length : '—'}</div>
          <div className="stat-foot">
            {t('dash.unclosedP', { p: periodText })}
            <Link href={`/reports?report=unclosed-visits&${q}`}>{t('common.open')} →</Link>
          </div>
        </section>

        {payback && (
          <section className="card stat">
            <div className="stat-top">
              {t('pb.booked')}
              <span className="stat-icon"><Icon name="trend" /></span>
            </div>
            <div className="stat-value">{payback.booked}</div>
            <div className="stat-foot">
              <span>{t('pb.bookedSub', { n: payback.attended })} · {periodText}</span>
              <Link href="/payback">{t('common.open')} →</Link>
            </div>
          </section>
        )}
      </div>

      <h2 className="section-title">{t('dash.nowTitle')}</h2>
      <div className="stats">
        <section className="card stat">
          <div className="stat-top">
            {t('dash.openTasks')}
            <span className={`stat-icon${tasks?.overdue ? ' red' : ''}`}><Icon name="check" /></span>
          </div>
          <div className="stat-value">{tasks ? tasks.open : '—'}</div>
          <div className="stat-foot">
            <span style={{ color: tasks?.overdue ? 'var(--red)' : undefined }}>
              {t('dash.taskSub', { overdue: tasks?.overdue ?? '—', done: tasks?.doneToday ?? '—' })}
            </span>
            <Link href="/tasks">{t('common.open')} →</Link>
          </div>
        </section>

        {requests !== null && (
          <section className="card stat">
            <div className="stat-top">
              {t('dash.requests')}
              <span className={`stat-icon${requests ? ' red' : ''}`}><Icon name="message" /></span>
            </div>
            <div className="stat-value">{requests}</div>
            <div className="stat-foot">
              <span>{t('dash.requestsSub')}</span>
              <Link href="/inbox?tab=requests">{t('common.open')} →</Link>
            </div>
          </section>
        )}
        {toApprove !== null && (
          <section className="card stat">
            <div className="stat-top">
              {t('dash.toApprove')}
              <span className="stat-icon"><Icon name="zap" /></span>
            </div>
            <div className="stat-value">{toApprove}</div>
            <div className="stat-foot">
              <span>{t('dash.toApproveSub')}</span>
              <Link href="/automations">{t('common.open')} →</Link>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
