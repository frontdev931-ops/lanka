'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtNumber } from '../lib/ui';
import { Card, Empty } from './ui';

interface Row {
  key: string;
  label: string | null;
  channel: string;
  sent: number;
  replied: number;
  booked: number;
  attended: number;
  matured: number;
  bookedMatured: number;
  attendedVisit?: number;
  noShowVisit?: number;
  cancelledVisit?: number;
}
interface Results {
  attributionDays: number;
  rows: Row[];
  requests: { total: number; done: number; dismissed: number; open: number };
}

// Что происходило с пациентами после сообщений бота: ответили, записались, пришли. Для Instagram добавится тот же столбец «Канал».
export function MessagingResults({ months }: { months: number }) {
  const { t } = useI18n();
  const [data, setData] = useState<Results | null>(null);

  useEffect(() => {
    api<Results>(`/messages/results?months=${Math.min(months, 24)}`).then(setData).catch(() => setData(null));
  }, [months]);

  if (!data) return null;
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
  const name = (r: Row) => (r.key.startsWith('campaign:') ? `${t('camp.label')}: ${r.label ?? ''}` : t(`au.r.${r.key}` as never));

  return (
    <Card title={t('mr.title')}>
      <p className="rule" style={{ marginTop: 0 }}>{t('mr.note', { n: data.attributionDays })}</p>
      {data.rows.length === 0 ? (
        <Empty title={t('mr.empty')}>{t('mr.emptyHint')}</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('mr.colMsg')}</th>
              <th>{t('mr.colChannel')}</th>
              <th>{t('mr.colSent')}</th>
              <th>{t('mr.colReplied')}</th>
              <th>{t('mr.colResult')}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={`${r.key}|${r.channel}`}>
                <td className="cell-main">{name(r)}</td>
                <td>{r.channel}</td>
                <td>{fmtNumber(r.sent)}</td>
                <td>{fmtNumber(r.replied)} <span className="muted">({pct(r.replied, r.sent)})</span></td>
                <td style={{ whiteSpace: 'normal' }}>
                  {r.key === 'visit-reminder'
                    ? t('mr.reminderResult', { a: r.attendedVisit ?? 0, n: r.noShowVisit ?? 0, c: r.cancelledVisit ?? 0 })
                    : t('mr.bookedResult', { b: r.booked, a: r.attended, rate: pct(r.bookedMatured, r.matured) })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="rule" style={{ marginBottom: 0 }}>{t('mr.requests', { t: data.requests.total, d: data.requests.done, x: data.requests.dismissed, o: data.requests.open })}</p>
    </Card>
  );
}
