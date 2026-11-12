'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '../../../lib/api';
import { fmtMoney, fmtNumber } from '../../../lib/ui';
import { useI18n } from '../../../lib/i18n';
import { Alert, Card, Icon, Loading, PageHeader } from '../../../components/ui';

interface Payback {
  days: number;
  attributionDays: number;
  sent: number;
  booked: number;
  attended: number;
  remindedVisits: number;
  bookingRequestsDone: number;
  aiReplies: number;
  paid: number;
  plan: string;
  planPriceUah: number;
}

const PERIODS = [30, 90] as const;

// "Reports and analytics" → "Payback": what the messages and the AI brought in the chosen period, next to the price of the plan (GET /messages/payback,
// counted by code; owner and manager). The figures are a coincidence in time, not proof of a cause, and the page says so.
export default function PaybackPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Payback | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ role: string }>('/auth/me')
      .then((m) => {
        if (m.role !== 'OWNER' && m.role !== 'MANAGER') router.replace('/reports');
      })
      .catch(() => undefined);
  }, [router]);
  useEffect(() => {
    setData(null);
    setError('');
    api<Payback>(`/messages/payback?days=${days}`).then(setData).catch((e) => setError((e as Error).message));
  }, [days]);

  const stat = (label: string, value: string, foot: string, icon: string) => (
    <section className="card stat">
      <div className="stat-top">
        {label}
        <span className="stat-icon"><Icon name={icon} /></span>
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-foot"><span>{foot}</span></div>
    </section>
  );

  return (
    <>
      <PageHeader
        title={t('pb.title')}
        subtitle={t('pb.subtitle')}
        actions={
          <div className="toolbar seg" role="group" aria-label={t('dash.periodLabel')}>
            {PERIODS.map((d) => (
              <button key={d} type="button" className={days === d ? 'btn btn-sm btn-primary' : 'btn btn-sm'} aria-pressed={days === d} onClick={() => setDays(d)}>{t('dash.days', { n: d })}</button>
            ))}
          </div>
        }
      />
      {error && <Alert tone="error">{error}</Alert>}
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          <div className="stats">
            {stat(t('pb.booked'), fmtNumber(data.booked), t('pb.bookedSub', { n: data.attended }), 'calendar')}
            {stat(t('pb.paid'), fmtMoney(data.paid, t('billing.uah')), t('pb.paidSub'), 'trend')}
            {stat(t('pb.reminded'), fmtNumber(data.remindedVisits), t('pb.remindedSub'), 'check')}
            {stat(t('pb.requests'), fmtNumber(data.bookingRequestsDone), t('pb.requestsSub'), 'message')}
            {stat(t('pb.ai'), fmtNumber(data.aiReplies), t('pb.aiSub'), 'sparkles')}
            {stat(t('pb.sent'), fmtNumber(data.sent), t('dash.lastDays', { n: data.days }), 'zap')}
          </div>

          <Card title={t('pb.costTitle')}>
            {data.planPriceUah > 0 ? (
              <p className="rule" style={{ marginTop: 0 }}>{t('pb.cost', { sum: fmtNumber(data.planPriceUah), paid: fmtMoney(data.paid, t('billing.uah')), n: data.days })}</p>
            ) : (
              <p className="rule" style={{ marginTop: 0 }}>{t('pb.costCustom', { paid: fmtMoney(data.paid, t('billing.uah')), n: data.days })}</p>
            )}
            <p className="muted" style={{ fontSize: 13 }}>{t('pb.rule', { n: data.attributionDays })}</p>
            <p className="muted" style={{ fontSize: 13 }}>
              {t('pb.more')} <Link href="/analytics">{t('nav.funnel')}</Link>
            </p>
          </Card>
        </>
      )}
    </>
  );
}
