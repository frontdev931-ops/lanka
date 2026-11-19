'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Key, useI18n } from '../../../lib/i18n';
import { fmtDate, fmtDateTime } from '../../../lib/ui';
import { Alert, Badge, Card, Loading, PageHeader } from '../../../components/ui';
import { ProHint } from '../../../components/ProHint';

type State = 'fired' | 'ok' | 'insufficient' | 'needs_sync';
interface Signal {
  kind: 'CANCEL_RATE' | 'RETURN_DROP' | 'STALE_REQUESTS';
  state: State;
  threshold: number;
  windowDays: number;
  hours: number;
  notify: boolean;
  lastFiredAt: string | null;
  // null: the signal shows its own comparison (no report substantiates it)
  link: string | null;
  value?: number;
  count?: number;
  base?: number;
  need?: number;
  from?: string;
  to?: string;
  prevFrom?: string;
  prevTo?: string;
}
interface View {
  inPlan: boolean;
  checkedAt: string;
  sync: { lastSyncAt: string | null; fresh: boolean } | null;
  signals: Signal[];
}

const TONE: Record<State, 'red' | 'green' | 'gray' | 'amber'> = { fired: 'red', ok: 'green', insufficient: 'gray', needs_sync: 'amber' };
// a period's end is exclusive (the start of the next day): show the last day it covers
const lastDay = (iso: string) => fmtDate(new Date(Date.parse(iso) - 1).toISOString());

// Reports → "Signals": the manager's signals measured now from the clinic's own data (GET /signals). Read only: the thresholds and
// notifications are set in "Scheduled" (/insights). Nothing here is sent anywhere.
export default function SignalsPage() {
  const { t } = useI18n();
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    api<View>('/signals').then(setV).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const header = <PageHeader title={t('sig.title')} subtitle={t('sig.subtitle')} />;
  if (error)
    return (
      <>
        {header}
        <Alert tone="error">
          {t('sig.error')} <button className="btn btn-sm" onClick={load}>{t('sig.retry')}</button>
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

  const fired = v.signals.filter((s) => s.state === 'fired').length;
  const measured = v.signals.filter((s) => s.state === 'fired' || s.state === 'ok').length;
  const period = (s: Signal) => (s.from && s.to ? `${fmtDate(s.from)} — ${lastDay(s.to)}` : '');

  const what = (s: Signal): string => {
    if (s.state === 'needs_sync') return t('sig.needsSync');
    if (s.state === 'insufficient') return t(s.kind === 'RETURN_DROP' ? 'sig.RETURN_DROP.insufficient' : 'sig.insufficient', { n: s.base ?? 0, need: s.need ?? 0, period: period(s) });
    if (s.kind === 'CANCEL_RATE') return t('sig.CANCEL_RATE.what', { v: s.value ?? 0, n: s.count ?? 0, total: s.base ?? 0, period: period(s) });
    if (s.kind === 'RETURN_DROP') {
      const v2 = s.value ?? 0;
      return t(v2 > 0 ? 'sig.RETURN_DROP.less' : v2 < 0 ? 'sig.RETURN_DROP.more' : 'sig.RETURN_DROP.same', { cur: s.count ?? 0, prev: s.base ?? 0, v: Math.abs(v2), period: period(s), prevPeriod: s.prevFrom && s.prevTo ? `${fmtDate(s.prevFrom)} — ${lastDay(s.prevTo)}` : '' });
    }
    return t('sig.STALE_REQUESTS.what', { n: s.count ?? 0, h: s.hours, total: s.base ?? 0 });
  };
  const rule = (s: Signal) => (s.kind === 'STALE_REQUESTS' ? t('sig.STALE_REQUESTS.rule', { n: s.threshold, h: s.hours }) : s.kind === 'CANCEL_RATE' ? t('sig.CANCEL_RATE.rule', { n: s.threshold, d: s.windowDays }) : t('sig.RETURN_DROP.rule', { n: s.threshold, d: s.windowDays }));

  return (
    <>
      {header}
      {v.sync && !v.sync.fresh && (
        <Alert tone="warn">
          {v.sync.lastSyncAt ? t('sig.syncOld', { date: fmtDateTime(v.sync.lastSyncAt) }) : t('sig.syncNever')} <Link href="/settings">{t('sig.toSync')}</Link>
        </Alert>
      )}
      {fired > 0 ? (
        <Alert tone="warn">{t('sig.summaryFired', { n: fired })}</Alert>
      ) : measured === v.signals.length && measured > 0 ? (
        <Alert tone="success">{t('sig.summaryOk')}</Alert>
      ) : measured > 0 ? (
        <Alert tone="info">{t('sig.summaryPartial')}</Alert>
      ) : (
        <Alert tone="info">{t('sig.summaryNone')}</Alert>
      )}

      <div className="signal-list">
        {v.signals.map((s) => (
          <Card key={s.kind} title={t(`ins.alert.${s.kind}` as Key)} actions={<Badge tone={TONE[s.state]}>{t(`sig.state.${s.state}` as Key)}</Badge>}>
            <p className="signal-what" style={{ marginTop: 0 }}>{what(s)}</p>
            {(s.state === 'fired' || s.state === 'ok') && <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>{rule(s)}</p>}
            {s.state === 'fired' && <p className="rule" style={{ margin: '0 0 8px' }}>{t(`sig.${s.kind}.why` as Key)}</p>}
            {s.link && (
              <div className="toolbar">
                <Link className={`btn btn-sm${s.state === 'fired' ? ' btn-primary' : ''}`} href={s.link}>{t(`sig.${s.kind}.open` as Key)}</Link>
              </div>
            )}
            <details className="more-details" style={{ marginTop: 8 }}>
              <summary>{t('sig.how')}</summary>
              <p className="rule">{t(`sig.${s.kind}.how` as Key)}</p>
              <p className="muted" style={{ fontSize: 13 }}>
                {s.notify ? t('sig.notifyOn') : t('sig.notifyOff')}
                {s.lastFiredAt ? ` ${t('sig.lastFired', { date: fmtDateTime(s.lastFiredAt) })}` : ''} <Link href="/insights">{t('sig.settings')}</Link>
              </p>
            </details>
          </Card>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>{t('sig.checkedAt', { date: fmtDateTime(v.checkedAt) })}</p>
    </>
  );
}
