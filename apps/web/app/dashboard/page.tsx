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

export default function Dashboard() {
  const t = useT();
  const [noNext, setNoNext] = useState<Report | null>(null);
  const [missed, setMissed] = useState<Report | null>(null);
  const [unclosed, setUnclosed] = useState<Report | null>(null);
  const [tasks, setTasks] = useState<Summary | null>(null);
  const [integration, setIntegration] = useState<Integration | null>(null);

  useEffect(() => {
    api<Report>('/reports/no-next-visit').then(setNoNext).catch(() => {});
    api<Report>('/reports/missed-visits').then(setMissed).catch(() => {});
    api<Report>('/reports/unclosed-visits').then(setUnclosed).catch(() => {});
    api<Summary>('/tasks/summary').then(setTasks).catch(() => {});
    api<Integration>('/integrations/cliniccards').then(setIntegration).catch(() => {});
  }, []);

  const updated = noNext?.dataUpdatedAt ? fmtDateTime(noNext.dataUpdatedAt) : t('common.neverSynced');

  return (
    <>
      <PageHeader title={t('dash.title')} subtitle={t('dash.updated', { date: updated })} />

      {/* Что показать в пустом кабинете: демо-данные, пустую клинику без подключения или подключённую, но ещё не загруженную */}
      {integration?.mode === 'demo' && integration.lastSyncAt && (
        <Alert tone="warn">
          {t('dash.demo1')}
          <Link href="/integrations">{t('dash.demoLink')}</Link>
          {t('dash.demo2')}
        </Alert>
      )}
      {integration?.mode === 'demo' && !integration.lastSyncAt && (
        <Alert tone="info">
          {t('dash.noData1')}
          <Link href="/integrations">{t('dash.demoLink')}</Link>
          {t('dash.noData2')}
        </Alert>
      )}
      {integration?.mode === 'cliniccards' && !integration.lastSyncAt && (
        <Alert tone="info">
          {t('dash.notLoaded1')}
          <Link href="/integrations">{t('int.loadData')}</Link>
        </Alert>
      )}

      <div className="stats">
        <section className="card stat">
          <div className="stat-top">
            {t('dash.noNext')}
            <span className="stat-icon"><Icon name="calendar" /></span>
          </div>
          <div className="stat-value">{noNext ? noNext.rows.length : '—'}</div>
          <div className="stat-foot">
            {t('dash.noNextSub')}
            <Link href="/reports">{t('common.open')} →</Link>
          </div>
        </section>

        <section className="card stat">
          <div className="stat-top">
            {t('dash.missed')}
            <span className="stat-icon amber"><Icon name="userx" /></span>
          </div>
          <div className="stat-value">{missed ? missed.rows.length : '—'}</div>
          <div className="stat-foot">
            {t('dash.missedSub')}
            <Link href="/reports">{t('common.open')} →</Link>
          </div>
        </section>

        <section className="card stat">
          <div className="stat-top">
            {t('dash.unclosed')}
            <span className="stat-icon amber"><Icon name="clock" /></span>
          </div>
          <div className="stat-value">{unclosed ? unclosed.rows.length : '—'}</div>
          <div className="stat-foot">
            {t('dash.unclosedSub')}
            <Link href="/reports?report=unclosed-visits">{t('common.open')} →</Link>
          </div>
        </section>

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
      </div>
    </>
  );
}
