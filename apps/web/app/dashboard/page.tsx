'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { fmtDateTime } from '../../lib/ui';
import { Alert, Icon, PageHeader } from '../../components/ui';

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

// The period of the three report cards (one choice for all of them, remembered in the browser). The other cards show what waits now and have no period.
const PERIODS = [7, 30, 90] as const;
const PERIOD_KEY = 'stomat_dash_days';

export default function Dashboard() {
  const t = useT();
  const [noNext, setNoNext] = useState<Report | null>(null);
  const [missed, setMissed] = useState<Report | null>(null);
  const [unclosed, setUnclosed] = useState<Report | null>(null);
  const [tasks, setTasks] = useState<Summary | null>(null);
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [days, setDays] = useState<number>(30);
  // appointments that followed our messages in the period (owner and manager; another role gets no card)
  const [payback, setPayback] = useState<{ booked: number; attended: number } | null>(null);
  const [ready, setReady] = useState(false);
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
      const saved = Number(window.localStorage.getItem(PERIOD_KEY));
      if ((PERIODS as readonly number[]).includes(saved)) setDays(saved);
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
    api<Report>(`/reports/no-next-visit?days=${days}`).then(setNoNext).catch(() => {});
    api<Report>(`/reports/missed-visits?days=${days}`).then(setMissed).catch(() => {});
    api<Report>(`/reports/unclosed-visits?days=${days}`).then(setUnclosed).catch(() => {});
    setPayback(null);
    api<{ booked: number; attended: number }>(`/messages/payback?days=${days}`).then(setPayback).catch(() => {});
  }, [days, ready]);
  const pickDays = (d: number) => {
    setDays(d);
    try {
      window.localStorage.setItem(PERIOD_KEY, String(d));
    } catch {
      // not remembered, the choice still works for this visit
    }
  };

  const updated = noNext?.dataUpdatedAt ? fmtDateTime(noNext.dataUpdatedAt) : t('common.neverSynced');

  return (
    <>
      <PageHeader title={t('dash.title')} subtitle={t('dash.updated', { date: updated })} />

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
          {PERIODS.map((d) => (
            <button key={d} type="button" className={days === d ? 'btn btn-sm btn-primary' : 'btn btn-sm'} aria-pressed={days === d} onClick={() => pickDays(d)}>{t('dash.days', { n: d })}</button>
          ))}
        </div>
      </div>
      <div className="stats">
        <section className="card stat">
          <div className="stat-top">
            {t('dash.noNext')}
            <span className="stat-icon"><Icon name="calendar" /></span>
          </div>
          <div className="stat-value">{noNext ? noNext.rows.length : '—'}</div>
          <div className="stat-foot">
            {t('dash.noNextPeriod', { n: days })}
            <Link href={`/reports?report=no-next-visit&days=${days}`}>{t('common.open')} →</Link>
          </div>
        </section>

        <section className="card stat">
          <div className="stat-top">
            {t('dash.missed')}
            <span className="stat-icon amber"><Icon name="userx" /></span>
          </div>
          <div className="stat-value">{missed ? missed.rows.length : '—'}</div>
          <div className="stat-foot">
            {t('dash.lastDays', { n: days })}
            <Link href={`/reports?report=missed-visits&days=${days}`}>{t('common.open')} →</Link>
          </div>
        </section>

        <section className="card stat">
          <div className="stat-top">
            {t('dash.unclosed')}
            <span className="stat-icon amber"><Icon name="clock" /></span>
          </div>
          <div className="stat-value">{unclosed ? unclosed.rows.length : '—'}</div>
          <div className="stat-foot">
            {t('dash.unclosedPeriod', { n: days })}
            <Link href={`/reports?report=unclosed-visits&days=${days}`}>{t('common.open')} →</Link>
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
              <span>{t('pb.bookedSub', { n: payback.attended })}</span>
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
