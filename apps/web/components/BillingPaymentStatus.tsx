'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtDate, fmtNumber } from '../lib/ui';
import { Alert } from './ui';

export interface BillingCheckout {
  id: string;
  url: string | null;
  amountMinor?: number;
}

export type PaymentState = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'REVERSED';

interface BillingPayment extends BillingCheckout {
  status: PaymentState;
  amountMinor: number;
  setupMinor: number;
  periodFrom: string | null;
  periodTo: string | null;
  refundedMinor: number;
  review: boolean;
}

export function BillingPaymentStatus({ path, onSettled }: { path: string; onSettled?: () => void }) {
  const { t } = useI18n();
  const [payment, setPayment] = useState<BillingPayment | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let checks = 0;
    async function check() {
      try {
        const result = await api<BillingPayment>(path, { cache: 'no-store' });
        if (cancelled) return;
        setPayment(result);
        setError('');
        if (result.status !== 'PENDING') {
          onSettled?.();
          if (result.status === 'PAID') window.dispatchEvent(new Event('stomat:me-changed'));
        }
        if (result.status === 'PENDING' && !result.review && ++checks < 12) timer = setTimeout(check, 5_000);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    }
    void check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [path, onSettled, attempt]);

  const refresh = () => { setRefreshing(true); setAttempt((n) => n + 1); };
  const checkButton = <button className="btn" disabled={refreshing} onClick={refresh}>{t('billing.refreshPayment')}</button>;
  if (error) return <Alert tone="error">{error}<div className="toolbar" style={{ marginTop: 8 }}>{checkButton}</div></Alert>;
  if (!payment) return <Alert tone="info">{t('billing.checking')}</Alert>;
  const { status, amountMinor, setupMinor, periodFrom, periodTo, refundedMinor, review, url } = payment;
  const label = review ? 'billing.review' : status === 'PAID' ? 'billing.confirmed' :
    status === 'EXPIRED' ? 'billing.st.EXPIRED' : status === 'FAILED' ? 'billing.st.FAILED' :
    status === 'REVERSED' ? 'billing.st.REVERSED' : 'billing.pendingPayment';
  const sum = (minor: number) => fmtNumber(minor / 100);

  return (
    <Alert tone={status === 'PAID' && !refundedMinor ? 'success' : status === 'PENDING' && !review ? 'info' : 'warn'}>
      <strong role="status">{t(label)}</strong>
      <div>{t('billing.total', { sum: sum(amountMinor) })}</div>
      {setupMinor > 0 && <div>{t('billing.setupLine', { sum: sum(setupMinor) })}</div>}
      {periodFrom && periodTo && <div>{t('billing.period', { from: fmtDate(periodFrom), to: fmtDate(periodTo) })}</div>}
      {refundedMinor > 0 && <div>{t('billing.refundedSum', { sum: sum(refundedMinor) })}</div>}
      <div className="toolbar" style={{ marginTop: 8 }}>
        {url && <a className="btn btn-primary" href={url}>{t('billing.resume')}</a>}
        {checkButton}
      </div>
    </Alert>
  );
}
