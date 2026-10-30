'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Card, Empty } from './ui';

interface Row {
  userId: string;
  name: string;
  role: string;
  inquiries: number;
  inquiriesCame: number;
  requestsHandled: number;
  contacts: number;
  contactOutcomes: Record<string, number>;
}

// Work of the team by our own data. Cliniccards cannot tell administrators apart, so this counts only what is done in LANKA.
export function TeamWork({ months }: { months: number }) {
  const { t, label } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    api<Row[]>(`/funnel/staff?months=${months}`).then(setRows).catch(() => setRows(null));
  }, [months]);
  if (!rows) return null;
  const active = rows.filter((r) => r.inquiries + r.requestsHandled + r.contacts > 0);

  return (
    <Card flush title={t('tw.title')}>
      <p className="rule" style={{ margin: '12px 20px 0' }}>{t('tw.note')}</p>
      {active.length === 0 ? (
        <Empty title={t('tw.empty')}>{t('tw.emptyHint')}</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('tw.colName')}</th>
              <th>{t('tw.colInquiries')}</th>
              <th>{t('tw.colCame')}</th>
              <th>{t('tw.colRequests')}</th>
              <th>{t('tw.colContacts')}</th>
            </tr>
          </thead>
          <tbody>
            {active.map((r) => (
              <tr key={r.userId}>
                <td>
                  <div className="cell-main">{r.name}</div>
                  <div className="cell-sub">{label('role', r.role)}</div>
                </td>
                <td>{r.inquiries}</td>
                <td>{r.inquiries ? `${r.inquiriesCame} (${Math.round((r.inquiriesCame / r.inquiries) * 100)}%)` : '—'}</td>
                <td>{r.requestsHandled}</td>
                <td>
                  {r.contacts}
                  {r.contacts > 0 && <span className="muted"> · {t('tw.booked')}: {r.contactOutcomes.BOOKED ?? 0}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
