'use client';

import { useI18n } from '../lib/i18n';

export interface PeriodTotals { completed: number; cancelled: number; noShow: number; scheduled: number; unclosed: number; newPatients: number; paid: { currency: string | null; amount: number }[] }
export const day = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;

// The figures of a weekly or monthly report next to the previous period: the same table for the current calculation (/period-report) and for a
// saved report (/period-report/r/<id>, from its snapshot only)
export function PeriodFigures({ cur, prev, prevPeriod }: { cur: PeriodTotals; prev?: PeriodTotals; prevPeriod: { from: string; to: string } }) {
  const { t, locale } = useI18n();
  const share = (x?: PeriodTotals) => (x && x.scheduled > 0 ? `${(((x.cancelled + x.noShow) / x.scheduled) * 100).toLocaleString(locale === 'en' ? 'en-GB' : 'uk-UA', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}% (${x.cancelled + x.noShow} / ${x.scheduled})` : '—');
  const money = (x?: PeriodTotals) => (x ? (x.paid.length ? x.paid.map((m) => `${m.amount.toLocaleString('uk-UA')} ${m.currency === 'UAH' ? t('billing.uah') : m.currency ?? ''}`).join('; ') : '0') : '—');
  const rows: [string, string, string][] = [
    [t('pr.rowCompleted'), String(cur.completed), String(prev?.completed ?? '—')],
    [t('pr.rowNew'), String(cur.newPatients), String(prev?.newPatients ?? '—')],
    [t('pr.rowMissed'), share(cur), share(prev)],
    [t('pr.rowPaid'), money(cur), money(prev)],
    [t('pr.rowUnclosed'), String(cur.unclosed), String(prev?.unclosed ?? '—')],
  ];
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>{t('pr.colMetric')}</th>
            <th>{t('pr.colThis')}</th>
            <th>{`${t('pr.colPrev')} ${day(prevPeriod.from)} — ${day(prevPeriod.to)}`}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([a, b, d]) => (
            <tr key={a}>
              <td>{a}</td>
              <td><b>{b}</b></td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sig-sub-line">{t('pr.definitions')}</p>
    </>
  );
}
