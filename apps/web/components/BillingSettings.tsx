'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/ui';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card, Empty, Loading } from './ui';
import { BillingPaymentStatus, type BillingCheckout, type PaymentState } from './BillingPaymentStatus';

interface Overview {
  configured: boolean;
  // a branch of a network is paid by its network
  network?: { id: string; name: string } | null;
  pendingPaymentId: string | null;
  nextPeriod: { from: string; to: string };
  plan: string;
  status: 'AWAITING_PAYMENT' | 'ACTIVE' | 'PAST_DUE' | 'LAPSED';
  paidUntil: string | null;
  graceUntil: string | null;
  plans: { key: string; priceUah: number; totalUah: number; limits: { users: number; messagesPerMonth: number; aiRepliesPerMonth: number }; features: string[]; oneTimePro?: { includesSetup: boolean } }[];
  setupPaid: boolean;
  setupUah: number | null;
  pack: { replies: number; priceUah: number; bought: number; cap: number; periodFrom: string; periodTo: string | null };
  ai: { included: number; used: number; purchased: number; remaining: number };
  payments: { id: string; kind: string; plan: string | null; amountMinor: number; status: PaymentState; createdAt: string; paidAt: string | null; refundedMinor: number; oneTimePro: boolean }[];
}
const FEATURES = ['multi_channel', 'patient_agent', 'ai_assistant', 'ai_autoreply', 'advanced_analytics', 'daily_digest'] as const;

// Settings → "Payment" (the former /billing page): the plan, the first payment (connection + first month), renewal and the payment history.
// One compact card for AI replies: how many are left this period and the button to buy a pack (POST /billing/ai-pack; only the owner pays, canBuy).
export function BillingSettings({ canBuy = false }: { canBuy?: boolean } = {}) {
  const { t } = useI18n();
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [paymentId, setPaymentId] = useState<string | null>(null);

  const load = useCallback(() => api<Overview>('/billing').then(setO).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    setPaymentId(new URLSearchParams(window.location.search).get('payment'));
    void load();
  }, [load]);

  async function go(path: string, body?: object, quotedMinor?: number) {
    setBusy(true);
    setError('');
    try {
      const payment = await api<BillingCheckout>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      setPaymentId(payment.id);
      if (quotedMinor !== undefined && payment.amountMinor !== quotedMinor) {
        setError(t('billing.quoteChanged'));
        void load();
      } else if (payment.url) window.location.assign(payment.url);
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  }

  if (!o) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  if (o.network)
    return (
      <Alert tone="info">
        {t('billing.byNetwork', { name: o.network.name })} <a href="/network">{t('billing.toNetwork')}</a>
      </Alert>
    );
  const tracked = paymentId ?? o.pendingPaymentId;
  const active = o.status === 'ACTIVE' || o.status === 'PAST_DUE';
  const money = (minor: number) => `${(minor / 100).toLocaleString()} ${t('billing.uah')}`;

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      {!o.configured && <Alert tone="warn">{t('billing.notConfigured')}</Alert>}
      {tracked && <BillingPaymentStatus key={tracked} path={`/billing/payments/${encodeURIComponent(tracked)}`} onSettled={load} />}
      {o.status === 'AWAITING_PAYMENT' && <Alert tone="info">{t('billing.awaiting')}</Alert>}
      {o.status === 'LAPSED' && <Alert tone="warn">{t('billing.lapsed')}</Alert>}
      {o.status === 'PAST_DUE' && <Alert tone="warn">{t('billing.pastDue', { date: o.graceUntil ? fmtDate(o.graceUntil) : '' })}</Alert>}

      <Card title={t('billing.plansTitle')} actions={active ? <Badge tone="green">{t('billing.active', { date: o.paidUntil ? fmtDate(o.paidUntil) : '—' })}</Badge> : undefined}>

        <div className="plan-grid">
          {o.plans.map((p) => (
            <section key={p.key} className={`rule-card${o.plan === p.key && active ? ' plan-current' : ''}`}>
              <b>{p.key === 'START' ? t('billing.start') : t('billing.pro')}</b>
              {p.oneTimePro ? <p>{t('billing.oneTimePro')}</p> : <div className="stat-value" style={{ margin: '6px 0' }}>{p.priceUah.toLocaleString()} {t('billing.perMonth')}</div>}
              <ul className="terms-list">
                <li>{t('billing.limUsers', { n: p.limits.users })}</li>
                <li>{t('billing.limMessages', { n: p.limits.messagesPerMonth.toLocaleString() })}</li>
                <li>{t('billing.limAi', { n: p.limits.aiRepliesPerMonth.toLocaleString() })}</li>
                <li>{t('billing.base')}</li>
                {FEATURES.map((f) => (
                  <li key={f} className={p.features.includes(f) ? '' : 'muted'}>{p.features.includes(f) ? '✓ ' : '— '}{t(`billing.feat.${f}`)}</li>
                ))}
              </ul>
              <p>{t('billing.period', { from: fmtDate(o.nextPeriod.from), to: fmtDate(o.nextPeriod.to) })}</p>
              {p.oneTimePro ? (
                <>
                  {p.oneTimePro.includesSetup && <p>{t('billing.oneTimeProSetup')}</p>}
                  <p>{t('billing.oneTimeProRenewal', { sum: p.priceUah.toLocaleString() })}</p>
                </>
              ) : o.setupUah != null && <p>{t('billing.setupLine', { sum: o.setupUah.toLocaleString() })}</p>}
              <p><strong>{t('billing.total', { sum: p.totalUah.toLocaleString() })}</strong></p>
              {canBuy && <button className="btn btn-primary" disabled={busy || !o.configured} onClick={() => go('/billing/checkout', { plan: p.key }, p.totalUah * 100)}>{t('billing.pay')}</button>}
            </section>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 13 }}>{t('billing.secure')}</p>
      </Card>

      {/* only the offer: how many replies are used is on the plan card above (one place for the meter) */}
      <Card title={t('billing.aiTitle')}>
        {o.ai.purchased > 0 && <p className="rule" style={{ marginTop: 0 }}>{t('billing.aiBought', { n: o.ai.purchased.toLocaleString() })}</p>}
        <p className="rule">{t('billing.packOffer', { n: o.pack.replies.toLocaleString(), sum: o.pack.priceUah.toLocaleString() })}</p>
        {o.pack.periodTo && <p>{t('billing.period', { from: fmtDate(o.pack.periodFrom), to: fmtDate(o.pack.periodTo) })}</p>}
        {canBuy ? (
          <div className="toolbar">
            <button className="btn btn-primary" disabled={busy || !o.configured || !active || o.pack.bought >= o.pack.cap} onClick={() => go('/billing/ai-pack')}>
              {t('billing.pay')}
            </button>
            {o.pack.bought >= o.pack.cap && <span className="muted">{t('billing.packCap', { n: o.pack.cap })}</span>}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>{t('billing.packOwner')}</p>
        )}
      </Card>

      <Card flush title={t('billing.history')}>
        {o.payments.length === 0 ? (
          <Empty title={t('billing.noPayments')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('billing.colDate')}</th>
                  <th>{t('billing.colWhat')}</th>
                  <th>{t('billing.colSum')}</th>
                  <th>{t('billing.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {o.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDate(p.paidAt ?? p.createdAt)}</td>
                    <td>{p.oneTimePro ? t('billing.oneTimePro') : p.kind === 'AI_PACK' ? t('billing.kindPack') : t('billing.kindPlan', { plan: p.plan === 'PRO' ? t('billing.pro') : p.plan === 'START' ? t('billing.start') : (p.plan ?? '') })}</td>
                    <td>{money(p.amountMinor)}</td>
                    <td>
                      <Badge tone={p.status === 'PAID' ? 'green' : p.status === 'PENDING' ? 'amber' : 'red'}>{t(`billing.st.${p.status}`)}</Badge>
                      {p.status === 'PAID' && p.refundedMinor > 0 && <span> · {t('billing.refundedSum', { sum: (p.refundedMinor / 100).toLocaleString() })}</span>}
                      {p.status === 'PENDING' && <button className="btn btn-sm" onClick={() => setPaymentId(p.id)}>{t('billing.refreshPayment')}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
