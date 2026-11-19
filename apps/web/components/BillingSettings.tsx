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
  // null for a new clinic: its first paid month starts on the launch day
  nextPeriod: { from: string; to: string } | null;
  monthStartsAtLaunch: boolean;
  launch: { state: 'NONE' | 'DONE' } | { state: 'PENDING' | 'REVIEW'; plan: string; paidAt: string | null };
  renewal: { plan: string; priceUah: number; date: string | null } | null;
  plan: string;
  status: 'AWAITING_PAYMENT' | 'LAUNCH_PENDING' | 'ACTIVE' | 'PAST_DUE' | 'LAPSED';
  paidUntil: string | null;
  graceUntil: string | null;
  plans: { key: string; priceUah: number; listPriceUah: number; launchUah: number | null; totalUah: number; limits: { users: number; messagesPerMonth: number; aiRepliesPerMonth: number }; features: string[] }[];
  setupPaid: boolean;
  pack: { replies: number; priceUah: number; bought: number; cap: number; periodFrom: string; periodTo: string | null };
  ai: { included: number; used: number; purchased: number; remaining: number };
  payments: { id: string; kind: string; plan: string | null; amountMinor: number; setupMinor: number; status: PaymentState; createdAt: string; paidAt: string | null; refundedMinor: number }[];
}
// What each plan gives, benefits first (the server gates the features; this is only the description)
const BENEFITS = {
  START: ['billing.startB1', 'billing.startB2', 'billing.startB3', 'billing.startB4', 'billing.startB5'],
  PRO: ['billing.proB1', 'billing.proB2', 'billing.proB3', 'billing.proB4', 'billing.proB5'],
} as const;

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
  const planName = (k: string) => (k === 'PRO' ? t('billing.pro') : k === 'START' ? t('billing.start') : k);
  const pending = o.launch.state === 'PENDING' || o.launch.state === 'REVIEW' ? o.launch : null;

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      {!o.configured && <Alert tone="warn">{t('billing.notConfigured')}</Alert>}
      {tracked && <BillingPaymentStatus key={tracked} path={`/billing/payments/${encodeURIComponent(tracked)}`} onSettled={load} />}
      {o.status === 'AWAITING_PAYMENT' && <Alert tone="info">{t('billing.awaiting')}</Alert>}
      {pending?.state === 'PENDING' && <Alert tone="info"><strong>{t('billing.launchPendingBadge')}.</strong> {t('billing.launchPending', { plan: planName(pending.plan) })}</Alert>}
      {/* the launch payment was partly refunded before the start: no new purchase until support resolves it */}
      {pending?.state === 'REVIEW' && <Alert tone="warn">{t('billing.launchReview')}</Alert>}
      {o.renewal && o.paidUntil && <Alert tone="info">{t('billing.renewalCard', { plan: planName(o.renewal.plan), date: fmtDate(o.paidUntil), sum: o.renewal.priceUah.toLocaleString() })}</Alert>}
      {o.status === 'LAPSED' && <Alert tone="warn">{t('billing.lapsed')}</Alert>}
      {o.status === 'PAST_DUE' && <Alert tone="warn">{t('billing.pastDue', { date: o.graceUntil ? fmtDate(o.graceUntil) : '' })}</Alert>}

      <Card title={t('billing.plansTitle')} actions={active ? <Badge tone="green">{t('billing.active', { date: o.paidUntil ? fmtDate(o.paidUntil) : '—' })}</Badge> : pending ? <Badge tone="amber">{t('billing.launchPendingBadge')}</Badge> : undefined}>

        <div className="plan-grid">
          {o.plans.map((p) => (
            <section key={p.key} className={`rule-card${o.plan === p.key && (active || pending) ? ' plan-current' : ''}`}>
              <b>{planName(p.key)}</b>
              <div className="muted">{p.key === 'START' ? t('billing.startTitle') : t('billing.proTitle')}</div>
              <div className="stat-value" style={{ margin: '6px 0' }}>{p.priceUah.toLocaleString()} {t('billing.perMonth')}</div>
              {p.priceUah !== p.listPriceUah && <div className="muted" style={{ fontSize: 13 }}>{t('billing.yourPrice', { sum: p.listPriceUah.toLocaleString() })}</div>}
              <ul className="terms-list">
                {(BENEFITS[p.key as keyof typeof BENEFITS] ?? []).map((k) => <li key={k}>{t(k)}</li>)}
              </ul>
              {p.key === 'PRO' && <p className="muted" style={{ fontSize: 13 }}>{t('billing.proChannels')}</p>}
              <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>{t('billing.limitsTitle')}</p>
              <ul className="terms-list muted" style={{ fontSize: 13 }}>
                <li>{t('billing.limUsers', { n: p.limits.users })}</li>
                <li>{t('billing.limMessages', { n: p.limits.messagesPerMonth.toLocaleString() })}</li>
                <li>{t('billing.limAi', { n: p.limits.aiRepliesPerMonth.toLocaleString() })}</li>
              </ul>
              <p style={{ marginBottom: 0 }}>{t('billing.monthly', { sum: p.priceUah.toLocaleString() })}</p>
              {p.launchUah != null && <p style={{ margin: 0 }}>{t('billing.launchLine', { sum: p.launchUah.toLocaleString() })}</p>}
              <p><strong>{t('billing.total', { sum: p.totalUah.toLocaleString() })}</strong></p>
              {o.nextPeriod ? (
                <p>{t('billing.period', { from: fmtDate(o.nextPeriod.from), to: fmtDate(o.nextPeriod.to) })}</p>
              ) : o.monthStartsAtLaunch ? (
                <p className="muted" style={{ fontSize: 13 }}>{t('billing.launchStarts')}</p>
              ) : null}
              {canBuy && !pending && <button className="btn btn-primary" disabled={busy || !o.configured} onClick={() => go('/billing/checkout', { plan: p.key }, p.totalUah * 100)}>{t('billing.pay')}</button>}
            </section>
          ))}
        </div>
        {o.monthStartsAtLaunch && (
          <div className="rule">
            <p style={{ marginTop: 0 }}><strong>{t('billing.launchTitle')}</strong></p>
            <p>{t('billing.launchWhatStart')}</p>
            <p>{t('billing.launchWhatPro')}</p>
            <p className="muted" style={{ fontSize: 13 }}>{t('billing.launchOther')}</p>
          </div>
        )}
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
                    <td>{p.kind === 'AI_PACK' ? t('billing.kindPack') : t('billing.kindPlan', { plan: planName(p.plan ?? '') })}{p.setupMinor > 0 && <span className="cell-sub"> · {t('billing.withLaunch')}</span>}</td>
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
