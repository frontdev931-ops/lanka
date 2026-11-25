'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { Key, useI18n } from '../../../../lib/i18n';
import { fmtDateTime } from '../../../../lib/ui';
import { Alert, Badge, Loading, PageHeader } from '../../../../components/ui';
import { day } from '../../../../components/PeriodFigures';

type Kind = 'WEEKLY' | 'MONTHLY';
type RunStatus = 'pending' | 'sent' | 'partial' | 'failed' | 'unknown' | 'cancelled' | 'no_recipients';
interface Item { id: string; kind: Kind; from: string; to: string; source: 'SCHEDULED' | 'MANUAL'; state: 'READY' | 'STALE'; preparedAt: string; status: RunStatus; counts: { total: number; sent: number } }
interface Page { total: number; page: number; pages: number; items: Item[] }
const TONE: Record<RunStatus, 'green' | 'amber' | 'red' | 'gray'> = { sent: 'green', partial: 'amber', pending: 'gray', unknown: 'amber', failed: 'red', cancelled: 'gray', no_recipients: 'gray' };

// Reports → "Week and month" → History: the saved weekly and monthly reports (the clinic's scheduled ones and the person's own manual sends),
// newest first, a page at a time. Opening the history recalculates nothing and a preview never adds to it.
export default function PeriodReportHistory() {
  const { t } = useI18n();
  const [kind, setKind] = useState<Kind | ''>('');
  const [rows, setRows] = useState<Item[] | null>(null);
  const [meta, setMeta] = useState<{ page: number; pages: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async (k: Kind | '', page: number) => {
    setBusy(true);
    setError('');
    try {
      const r = await api<Page>(`/period-reports/runs?page=${page}${k ? `&kind=${k}` : ''}`);
      setRows((cur) => (page === 1 ? r.items : [...(cur ?? []), ...r.items]));
      setMeta({ page: r.page, pages: r.pages, total: r.total });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    setRows(null);
    void load(kind, 1);
  }, [kind, load]);

  return (
    <>
      <PageHeader title={t('prh.title')} subtitle={t('prh.subtitle')} actions={<Link className="btn btn-sm" href="/period-report">{t('prh.toCurrent')}</Link>} />
      <div className="seg" role="tablist" aria-label={t('pr.kind')} style={{ marginBottom: 12 }}>
        {(['', 'WEEKLY', 'MONTHLY'] as const).map((k) => (
          <button key={k || 'all'} type="button" role="tab" aria-selected={kind === k} className={`btn btn-sm${kind === k ? ' btn-primary' : ''}`} onClick={() => setKind(k)}>
            {k === '' ? t('prh.all') : t(k === 'WEEKLY' ? 'pr.week' : 'pr.month')}
          </button>
        ))}
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <section className="card"><p style={{ margin: 0 }}>{t('prh.empty')}</p></section>
      ) : (
        <section className="card">
          <table className="table">
            <thead>
              <tr>
                <th>{t('prh.colReport')}</th>
                <th>{t('prh.colPeriod')}</th>
                <th>{t('prh.colPrepared')}</th>
                <th>{t('prh.colHow')}</th>
                <th>{t('prh.colDelivery')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/period-report/r/${r.id}`}><b>{t(r.kind === 'WEEKLY' ? 'pr.week' : 'pr.month')}</b></Link></td>
                  <td>{`${day(r.from)} — ${day(r.to)}`}</td>
                  <td>{fmtDateTime(r.preparedAt)}</td>
                  <td>{t(r.source === 'MANUAL' ? 'prh.manual' : 'prh.scheduled')}</td>
                  <td>
                    {r.state === 'STALE' && <Badge tone="amber" className="badge-wrap">{t('prh.notFormed')}</Badge>}{' '}
                    <Badge tone={TONE[r.status]} className="badge-wrap">{t(`prh.st.${r.status}` as Key, { n: r.counts.sent, total: r.counts.total })}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {meta && meta.page < meta.pages && (
            <div className="toolbar" style={{ marginTop: 10 }}>
              <button className="btn" disabled={busy} onClick={() => void load(kind, meta.page + 1)}>{t('prh.more', { shown: rows.length, total: meta.total })}</button>
            </div>
          )}
          <p className="sig-sub-line">{t('prh.acceptedNote')}</p>
        </section>
      )}
    </>
  );
}
