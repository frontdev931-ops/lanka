'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { fmtNumber } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Loading, PageHeader, statusTone } from '../../../components/ui';
import { FunnelBars, FunnelRow } from '../../../components/FunnelBars';
import { MessagingResults } from '../../../components/MessagingResults';
import { TeamWork } from '../../../components/TeamWork';

type Counts = { card: number; booked: number; came: number; started: number; paid: number; repeat: number; active: number };
interface Overview {
  money: { paid: number; payers: number; openPlanNotStarted: number; openPlanStarted: number } | null;
  months: number;
  lostAfterDays: number;
  counts: Counts;
  medians: { cardToBooked: number | null; bookedToCame: number | null; cameToStarted: number | null };
  cohorts: ({ month: string } & Counts)[];
  bySource: ({ name: string; paidSum: number } & Counts)[];
  byDirection: ({ name: string; paidSum: number } & Counts)[];
  leaks: Record<string, number>;
  sources: string[];
  directions: string[];
}
interface InquiryFunnel {
  months: number;
  counts: { total: number; card: number; booked: number; came: number; started: number; lost: number };
  returning: number;
  byChannel: ({ name: string } & { total: number; card: number; booked: number; came: number; started: number; lost: number })[];
}
interface People {
  reason: string;
  total: number;
  rows: { patientId: string; fullName: string; phone: string | null; source: string; direction: string | null; createdAt: string; lastEvidenceAt: string | null; lastStatus: string | null; openPlanSum: number }[];
}

const PATH_STAGES = ['card', 'booked', 'came', 'started', 'paid'] as const;
const RETURN_STAGES = ['came', 'repeat', 'active'] as const;
const HEAT_COLS = ['booked', 'came', 'started', 'paid', 'repeat', 'active'] as const;
// Причины остановки в порядке пути пациента; «записан, приём впереди» не потеря, а ожидание
const LEAKS = ['no-booking', 'unclosed', 'cancelled', 'no-show', 'moved', 'upcoming', 'not-started', 'not-paid', 'no-return', 'lost'] as const;
const FRESH_DAYS = 90;

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);

export default function AnalyticsPage() {
  const { t, label } = useI18n();
  const [months, setMonths] = useState(12);
  const [source, setSource] = useState('');
  const [direction, setDirection] = useState('');
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const [people, setPeople] = useState<People | null>(null);
  const [inq, setInq] = useState<InquiryFunnel | null>(null);

  const qs = useCallback(() => {
    const p = new URLSearchParams({ months: String(months) });
    if (source) p.set('source', source);
    if (direction) p.set('direction', direction);
    return p.toString();
  }, [months, source, direction]);

  useEffect(() => {
    setLoading(true);
    setReason(null);
    setPeople(null);
    api<Overview>(`/funnel?${qs()}`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [qs]);

  useEffect(() => {
    api<InquiryFunnel>(`/funnel/inquiries?months=${months}`).then(setInq).catch(() => setInq(null));
  }, [months]);

  async function showPeople(r: string) {
    if (reason === r) return setReason(null);
    setReason(r);
    setPeople(null);
    try {
      setPeople(await api<People>(`/funnel/people?reason=${r}&${qs()}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const stage = (k: string) => t(`fn.st.${k}` as never);
  const fmt = (n: number) => fmtNumber(n);

  const c = data?.counts;
  const pathRows: FunnelRow[] = c ? PATH_STAGES.map((k) => ({ key: k, label: stage(k), value: c[k], hint: t(`fn.hint.${k}` as never) })) : [];
  const returnRows: FunnelRow[] = c ? RETURN_STAGES.map((k) => ({ key: k, label: stage(k), value: c[k], hint: t(`fn.hint.${k}` as never, { days: data!.lostAfterDays }) })) : [];
  const leakMax = data ? Math.max(1, ...LEAKS.map((r) => data.leaks[r] ?? 0)) : 1;
  const freshBefore = Date.now() - FRESH_DAYS * 86_400_000;
  const isFresh = (month: string) => new Date(`${month}-01T00:00:00Z`).getTime() > freshBefore - 30 * 86_400_000;
  const heat = (v: number | null) => (v === null ? undefined : { background: `rgba(14, 154, 160, ${0.06 + 0.55 * (v / 100)})` });

  const compareTable = (rows: Overview['bySource'], first: string) => (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{first}</th>
            <th className="num">{t('fn.cards')}</th>
            <th className="num">{t('fn.st.came')}</th>
            <th className="num">{t('fn.st.started')}</th>
            <th className="num">{t('fn.st.paid')}</th>
            <th className="num">{t('fn.st.repeat')}</th>
            <th className="num">{t('fn.paidSum')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td><span className="cell-main">{r.name}</span></td>
              <td className="num">{fmt(r.card)}</td>
              <td className="num">{pct(r.came, r.card) ?? '—'}%</td>
              <td className="num">{pct(r.started, r.card) ?? '—'}%</td>
              <td className="num">{pct(r.paid, r.card) ?? '—'}%</td>
              <td className="num">{pct(r.repeat, r.card) ?? '—'}%</td>
              <td className="num">{fmt(r.paidSum)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <PageHeader title={t('fn.title')} subtitle={t('fn.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}

      <div className="toolbar" style={{ marginBottom: 16 }}>
        <label className="inline-label">
          {t('fn.period')}
          <select className="select" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {[3, 6, 12, 24].map((m) => (
              <option key={m} value={m}>{t('fn.months', { n: m })}</option>
            ))}
          </select>
        </label>
        <select className="select" value={source} onChange={(e) => setSource(e.target.value)} aria-label={t('fn.source')}>
          <option value="">{t('rep.allSources')}</option>
          {(data?.sources ?? []).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select className="select" value={direction} onChange={(e) => setDirection(e.target.value)} aria-label={t('fn.direction')}>
          <option value="">{t('fn.allDirections')}</option>
          {(data?.directions ?? []).map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>

      {!data ? (
        <Loading />
      ) : !c || c.card === 0 ? (
        <Card><Empty title={t('fn.empty')}>{t('fn.emptyHint')}</Empty></Card>
      ) : (
        <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity .15s' }}>
          <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <section className="card stat">
              <div className="stat-top">{t('fn.kpiCards')}</div>
              <div className="stat-value">{fmt(c.card)}</div>
              <div className="stat-foot">{t('fn.kpiCardsSub', { n: data.months })}</div>
            </section>
            <section className="card stat">
              <div className="stat-top">{t('fn.kpiCame')}</div>
              <div className="stat-value">{pct(c.came, c.card) ?? '—'}%</div>
              <div className="stat-foot">{t('fn.kpiOf', { a: fmt(c.came), b: fmt(c.card) })}</div>
            </section>
            <section className="card stat">
              <div className="stat-top">{t('fn.kpiStarted')}</div>
              <div className="stat-value">{pct(c.started, c.came) ?? '—'}%</div>
              <div className="stat-foot">{t('fn.kpiOfCame', { a: fmt(c.started), b: fmt(c.came) })}</div>
            </section>
            <section className="card stat">
              <div className="stat-top">{t('fn.kpiReturn')}</div>
              <div className="stat-value">{pct(c.repeat, c.came) ?? '—'}%</div>
              <div className="stat-foot">{t('fn.kpiOfCame', { a: fmt(c.repeat), b: fmt(c.came) })}</div>
            </section>
          </div>

          {data.money && (
            <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
              <section className="card stat">
                <div className="stat-top">{t('fn.moneyPaid')}</div>
                <div className="stat-value">{fmt(data.money.paid)}</div>
                <div className="stat-foot">{t('fn.moneyPayers', { n: data.money.payers })}</div>
              </section>
              <section className="card stat">
                <div className="stat-top">{t('fn.moneyOpenStarted')}</div>
                <div className="stat-value">{fmt(data.money.openPlanStarted)}</div>
                <div className="stat-foot">{t('fn.moneyOpenStartedHint')}</div>
              </section>
              <section className="card stat">
                <div className="stat-top">{t('fn.moneyOpenStuck')}</div>
                <div className="stat-value">{fmt(data.money.openPlanNotStarted)}</div>
                <div className="stat-foot">{t('fn.moneyOpenStuckHint')}</div>
              </section>
            </div>
          )}

          {inq && inq.counts.total === 0 && (
            <Alert tone="info">
              {t('fn.topEmpty')} <Link href="/inquiries">{t('fn.topEmptyLink')}</Link>
            </Alert>
          )}
          {inq && inq.counts.total > 0 && (
            <Card title={t('fn.topTitle')}>
              <p className="rule">{t('fn.topRule', { returning: inq.returning })}</p>
              <FunnelBars
                rows={[
                  { key: 'inq', label: t('fn.top.total'), value: inq.counts.total, hint: t('fn.topHint.total') },
                  { key: 'card', label: t('fn.top.card'), value: inq.counts.card, hint: t('fn.topHint.card') },
                  { key: 'booked', label: t('fn.top.booked'), value: inq.counts.booked, hint: t('fn.topHint.booked') },
                  { key: 'came', label: t('fn.top.came'), value: inq.counts.came, hint: t('fn.topHint.came') },
                ]}
                ariaLabel={t('fn.topTitle')}
                ofStart={t('fn.ofInq')}
                ofPrev={t('fn.ofPrev')}
                fmt={fmt}
              />
              <p className="rule" style={{ marginTop: 10 }}>{t('fn.topLost', { n: inq.counts.lost })}</p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('inq.channel')}</th>
                      <th className="num">{t('fn.top.total')}</th>
                      <th className="num">{t('fn.top.card')}</th>
                      <th className="num">{t('fn.top.booked')}</th>
                      <th className="num">{t('fn.top.came')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inq.byChannel.map((r) => (
                      <tr key={r.name}>
                        <td><span className="cell-main">{t(`inq.ch.${r.name}` as never)}</span></td>
                        <td className="num">{fmt(r.total)}</td>
                        <td className="num">{pct(r.card, r.total) ?? '—'}%</td>
                        <td className="num">{pct(r.booked, r.total) ?? '—'}%</td>
                        <td className="num">{pct(r.came, r.total) ?? '—'}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card title={t('fn.pathTitle')}>
            <p className="rule">{t('fn.pathRule')}</p>
            <FunnelBars rows={pathRows} ariaLabel={t('fn.pathTitle')} ofStart={t('fn.ofStart')} ofPrev={t('fn.ofPrev')} fmt={fmt} />
            <p className="rule" style={{ marginTop: 14 }}>
              {t('fn.medians', {
                a: data.medians.cardToBooked ?? '—',
                b: data.medians.bookedToCame ?? '—',
                c: data.medians.cameToStarted ?? '—',
              })}
            </p>
          </Card>

          <Card title={t('fn.returnTitle')}>
            <p className="rule">{t('fn.returnRule', { days: data.lostAfterDays })}</p>
            <FunnelBars rows={returnRows} ariaLabel={t('fn.returnTitle')} ofStart={t('fn.ofStart')} ofPrev={t('fn.ofPrev')} fmt={fmt} />
          </Card>

          <Card title={t('fn.leaksTitle')}>
            <p className="rule">{t('fn.leaksRule')}</p>
            <div className="leaks">
              {LEAKS.map((r) => {
                const n = data.leaks[r] ?? 0;
                return (
                  <div key={r} className={`leak-row${reason === r ? ' on' : ''}${r === 'upcoming' ? ' info' : ''}`}>
                    <div className="leak-name">{t(`fn.r.${r}` as never, { days: data.lostAfterDays })}</div>
                    <div className="leak-track">
                      <span className="leak-bar" style={{ width: `${(n / leakMax) * 100}%` }} />
                      <span className="leak-val">{fmt(n)}</span>
                    </div>
                    <button className="btn btn-sm" disabled={n === 0} onClick={() => showPeople(r)} aria-expanded={reason === r}>
                      {reason === r ? t('fn.hide') : t('fn.show')}
                    </button>
                  </div>
                );
              })}
            </div>
            {reason && (
              <div className="leak-people">
                <p className="rule"><b>{t(`fn.r.${reason}` as never, { days: data.lostAfterDays })}.</b> {t(`fn.rh.${reason}` as never, { days: data.lostAfterDays })}</p>
                {!people ? (
                  <Loading />
                ) : (
                  <>
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>{t('pat.colPatient')}</th><th>{t('pat.colPhone')}</th><th>{t('fn.source')}</th>
                            <th>{t('fn.created')}</th><th>{t('fn.lastEvidence')}</th><th>{t('fn.lastStatus')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {people.rows.map((p) => (
                            <tr key={p.patientId}>
                              <td><Link href={`/patients/${p.patientId}`} className="cell-main">{p.fullName}</Link></td>
                              <td>{p.phone ?? <span className="muted">—</span>}</td>
                              <td>{p.source}</td>
                              <td>{p.createdAt.split('-').reverse().join('.')}</td>
                              <td>{p.lastEvidenceAt ? p.lastEvidenceAt.split('-').reverse().join('.') : <span className="muted">—</span>}</td>
                              <td>{p.lastStatus ? <Badge tone={statusTone(p.lastStatus)}>{label('status', p.lastStatus)}</Badge> : <span className="muted">—</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="table-foot">{people.total > people.rows.length ? t('fn.shownOf', { n: people.rows.length, total: fmt(people.total) }) : t('rep.rows', { n: people.total })}</div>
                  </>
                )}
              </div>
            )}
          </Card>

          <Card title={t('fn.cohortTitle')}>
            <p className="rule">{t('fn.cohortRule')}</p>
            <div className="table-wrap">
              <table className="heat">
                <thead>
                  <tr>
                    <th>{t('fn.month')}</th>
                    <th className="num">{t('fn.cards')}</th>
                    {HEAT_COLS.map((k) => (
                      <th key={k} className="num">{t(`fn.col.${k}` as never)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.cohorts.map((row) => {
                    const fresh = isFresh(row.month);
                    return (
                      <tr key={row.month} className={fresh ? 'fresh' : ''}>
                        <th scope="row">{row.month.split('-').reverse().join('.')}{fresh ? ' *' : ''}</th>
                        <td className="num">{fmt(row.card)}</td>
                        {HEAT_COLS.map((k) => {
                          const v = pct(row[k], row.card);
                          return (
                            <td key={k} className="num heat-cell" style={heat(v)} title={`${fmt(row[k])} / ${fmt(row.card)}`}>
                              {v === null ? '—' : `${v}%`}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="rule" style={{ marginTop: 10 }}>* {t('fn.fresh', { days: FRESH_DAYS })}</p>
          </Card>

          <Card title={t('fn.bySource')}>
            <p className="rule">{t('fn.sourceNote')}</p>
            {compareTable(data.bySource, t('fn.source'))}
          </Card>

          <Card title={t('fn.byDirection')}>
            <p className="rule">{t('fn.directionNote')}</p>
            {data.byDirection.length ? compareTable(data.byDirection, t('fn.direction')) : <Empty title="—" />}
          </Card>
        </div>
      )}

      <TeamWork months={months} />

      <MessagingResults months={months} />
    </>
  );
}
