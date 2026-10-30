'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { fmtDate } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';

interface Summary {
  months: number;
  asked: number;
  count: number;
  average: number | null;
  positivePct: number | null;
  responseRate: number | null;
  distribution: { rating: number; count: number }[];
  byDoctor: { doctor: string; count: number; average: number | null; low: number }[];
  byMonth: { month: string; count: number; average: number | null }[];
  low: { id: string; rating: number; comment: string | null; doctorName: string | null; createdAt: string; patient: { id: string; fullName: string } }[];
  settings: { reviewUrl: string | null; collecting: boolean };
}

// Оценки пациентов после визита: собирает бот кнопками 1-5, администратор ничего не вводит
export default function QualityPage() {
  const { t } = useI18n();
  const [months, setMonths] = useState(3);
  const [data, setData] = useState<Summary | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<Summary>(`/reviews?months=${months}`).then((d) => { setData(d); setUrl(d.settings.reviewUrl ?? ''); }).catch((e) => setError((e as Error).message)), [months]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!info) return;
    const id = setTimeout(() => setInfo(''), 5000);
    return () => clearTimeout(id);
  }, [info]);

  const saveUrl = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/reviews/settings', { method: 'PATCH', body: JSON.stringify({ reviewUrl: url.trim() }) });
      setInfo(t('common.saved'));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  const max = Math.max(1, ...data.distribution.map((d) => d.count));

  return (
    <>
      <PageHeader
        title={t('q.title')}
        subtitle={t('q.subtitle')}
        actions={
          <select className="select" value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label={t('q.period')}>
            {[1, 3, 6, 12].map((m) => (
              <option key={m} value={m}>{t('fn.months', { n: m })}</option>
            ))}
          </select>
        }
      />
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      {!data.settings.collecting && (
        <Alert tone="info">
          {t('q.notCollecting')} <Link href="/automations">{t('q.goAutomations')}</Link>
        </Alert>
      )}

      <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <section className="card stat">
          <div className="stat-top">{t('q.avg')}</div>
          <div className="stat-value">{data.average ?? '—'}</div>
          <div className="stat-foot">{t('q.ofFive')}</div>
        </section>
        <section className="card stat">
          <div className="stat-top">{t('q.count')}</div>
          <div className="stat-value">{data.count}</div>
          <div className="stat-foot">{t('q.asked', { n: data.asked })}</div>
        </section>
        <section className="card stat">
          <div className="stat-top">{t('q.positive')}</div>
          <div className="stat-value">{data.positivePct === null ? '—' : `${data.positivePct}%`}</div>
          <div className="stat-foot">{t('q.positiveHint')}</div>
        </section>
        <section className="card stat">
          <div className="stat-top">{t('q.response')}</div>
          <div className="stat-value">{data.responseRate === null ? '—' : `${data.responseRate}%`}</div>
          <div className="stat-foot">{t('q.responseHint')}</div>
        </section>
      </div>

      <Card title={t('q.reviewLink')}>
        <p className="rule" style={{ marginTop: 0 }}>{t('q.reviewLinkHint')}</p>
        <div className="toolbar">
          <input className="input grow" type="url" inputMode="url" placeholder="https://g.page/r/…/review" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={300} />
          <button className="btn" disabled={busy || url.trim() === (data.settings.reviewUrl ?? '')} onClick={saveUrl}>{t('common.save')}</button>
        </div>
      </Card>

      {data.count === 0 ? (
        <Card>
          <Empty title={t('q.empty')}>{t('q.emptyHint')}</Empty>
        </Card>
      ) : (
        <>
          <Card title={t('q.distribution')}>
            <div className="q-bars">
              {[...data.distribution].reverse().map((d) => (
                <div key={d.rating} className="q-bar-row">
                  <span className="q-bar-label">{d.rating}</span>
                  <span className="q-bar-track">
                    <span className="q-bar" style={{ width: `${(d.count / max) * 100}%`, opacity: d.rating <= 3 ? 0.55 : 1 }} />
                  </span>
                  <span className="q-bar-val">{d.count}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card flush title={t('q.byDoctor')}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('q.doctor')}</th>
                  <th>{t('q.count')}</th>
                  <th>{t('q.avg')}</th>
                  <th>{t('q.low')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byDoctor.map((r) => (
                  <tr key={r.doctor}>
                    <td className="cell-main">{r.doctor}</td>
                    <td>{r.count}</td>
                    <td>{r.average}</td>
                    <td>{r.low > 0 ? <Badge tone="amber">{r.low}</Badge> : 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card flush title={t('q.byMonth')}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('q.month')}</th>
                  <th>{t('q.count')}</th>
                  <th>{t('q.avg')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byMonth.map((r) => (
                  <tr key={r.month}>
                    <td className="cell-main">{r.month}</td>
                    <td>{r.count}</td>
                    <td>{r.average}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card flush title={t('q.lowTitle')}>
            {data.low.length === 0 ? (
              <Empty title={t('q.noLow')} />
            ) : (
              data.low.map((r) => (
                <div key={r.id} className="req-item">
                  <span className="chat-name">
                    <Link href={`/patients/${r.patient.id}`}><b>{r.patient.fullName}</b></Link>
                    <Badge tone="amber">{r.rating} / 5</Badge>
                    {r.doctorName && <span className="muted">{r.doctorName}</span>}
                  </span>
                  <span>{r.comment ?? <span className="muted">{t('q.noComment')}</span>}</span>
                  <span className="muted chat-time">{fmtDate(r.createdAt)}</span>
                </div>
              ))
            )}
          </Card>
        </>
      )}
    </>
  );
}
