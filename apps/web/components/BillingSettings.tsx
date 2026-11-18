'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/ui';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card, Empty, Loading } from './ui';

interface Overview {
  configured: boolean;
  // a branch of a network is paid by its network
  network?: { id: string; name: string } | null;
  // LiqPay's test mode on this server (never in production)
  sandbox?: boolean;
  // a payment sent to LiqPay in the last 30 minutes is not confirmed yet
  checking?: boolean;
  plan: string;
  status: 'AWAITING_PAYMENT' | 'ACTIVE' | 'PAST_DUE' | 'LAPSED';
  paidUntil: string | null;
  graceUntil: string | null;
  plans: { key: string; priceUah: number; limits: { users: number; messagesPerMonth: number; aiRepliesPerMonth: number }; features: string[] }[];
  setupPaid: boolean;
  setupUah: number | null;
  pack: { replies: number; priceUah: number; bought: number; cap: number };
  ai: { included: number; used: number; purchased: number; remaining: number };
  payments: { id: string; kind: string; plan: string | null; amountMinor: number; status: string; createdAt: string; paidAt: string | null }[];
}
interface Form {
  url: string;
  data: string;
  signature: string;
}

const FEATURES = ['multi_channel', 'patient_agent', 'ai_assistant', 'ai_autoreply', 'advanced_analytics', 'daily_digest'] as const;

// Settings → "Payment" (the former /billing page): the plan, the first payment (connection + first month), renewal and the payment history.
// One compact card for AI replies: how many are left this period and the button to buy a pack (POST /billing/ai-pack; only the owner pays, canBuy).
// The card is entered on the LiqPay page; we only send the person there.
export function BillingSettings({ canBuy = false }: { canBuy?: boolean } = {}) {
  const { t } = useI18n();
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const load = useCallback(() => api<Overview>('/billing').then(setO).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (form) formRef.current?.submit();
  }, [form]);
  // After coming back from the payment page the status waits for LiqPay's signed call to the server; the page asks again for two minutes
  const checking = !!o?.checking;
  useEffect(() => {
    if (!checking) return;
    let n = 0;
    const id = setInterval(() => {
      if (++n > 24) clearInterval(id);
      else void load();
    }, 5000);
    return () => clearInterval(id);
  }, [checking, load]);

  async function go(path: string, body?: object) {
    setBusy(true);
    setError('');
    try {
      setForm(await api<Form>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }));
    } catch (e) {
      setError((e as Error).message);
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
  const active = o.status === 'ACTIVE' || o.status === 'PAST_DUE';
  const money = (minor: number) => `${(minor / 100).toLocaleString()} ${t('billing.uah')}`;

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      {!o.configured && <Alert tone="warn">{t('billing.notConfigured')}</Alert>}
      {o.sandbox && <Alert tone="warn">{t('billing.sandbox')}</Alert>}
      {o.checking && <Alert tone="info">{t('billing.checking')}</Alert>}
      {o.status === 'AWAITING_PAYMENT' && <Alert tone="info">{t('billing.awaiting')}</Alert>}
      {o.status === 'LAPSED' && <Alert tone="warn">{t('billing.lapsed')}</Alert>}
      {o.status === 'PAST_DUE' && <Alert tone="warn">{t('billing.pastDue', { date: o.graceUntil ? fmtDate(o.graceUntil) : '' })}</Alert>}

      {form && (
        <form ref={formRef} method="POST" action={form.url} acceptCharset="utf-8">
          <input type="hidden" name="data" value={form.data} />
          <input type="hidden" name="signature" value={form.signature} />
        </form>
      )}

      <Card title={t('billing.plansTitle')} actions={active ? <Badge tone="green">{t('billing.active', { date: o.paidUntil ? fmtDate(o.paidUntil) : '—' })}</Badge> : undefined}>
        {!o.setupPaid && <p className="rule" style={{ marginTop: 0 }}>{t('billing.setupNote', { sum: o.setupUah ? o.setupUah.toLocaleString() : '—' })}</p>}
        <div className="plan-grid">
          {o.plans.map((p) => (
            <section key={p.key} className={`rule-card${o.plan === p.key && active ? ' plan-current' : ''}`}>
              <b>{p.key === 'START' ? t('billing.start') : t('billing.pro')}</b>
              <div className="stat-value" style={{ margin: '6px 0' }}>{p.priceUah.toLocaleString()} {t('billing.perMonth')}</div>
              <ul className="terms-list">
                <li>{t('billing.limUsers', { n: p.limits.users })}</li>
                <li>{t('billing.limMessages', { n: p.limits.messagesPerMonth.toLocaleString() })}</li>
                <li>{t('billing.limAi', { n: p.limits.aiRepliesPerMonth.toLocaleString() })}</li>
                <li>{t('billing.base')}</li>
                {FEATURES.map((f) => (
                  <li key={f} className={p.features.includes(f) ? '' : 'muted'}>{p.features.includes(f) ? '✓ ' : '— '}{t(`billing.feat.${f}`)}</li>
                ))}
              </ul>
              <button className="btn btn-primary" disabled={busy || !o.configured} onClick={() => go('/billing/checkout', { plan: p.key })}>
                {active && o.plan === p.key ? t('billing.renew') : o.status === 'AWAITING_PAYMENT' ? t('billing.payFirst') : t('billing.pay')}
              </button>
            </section>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 13 }}>{t('billing.secure')}</p>
      </Card>

      {/* only the offer: how many replies are used is on the plan card above (one place for the meter) */}
      <Card title={t('billing.aiTitle')}>
        {o.ai.purchased > 0 && <p className="rule" style={{ marginTop: 0 }}>{t('billing.aiBought', { n: o.ai.purchased.toLocaleString() })}</p>}
        <p className="rule">{t('billing.packOffer', { n: o.pack.replies.toLocaleString(), sum: o.pack.priceUah.toLocaleString() })}</p>
        {canBuy ? (
          <div className="toolbar">
            <button className="btn btn-primary" disabled={busy || !o.configured || !active || o.pack.bought >= o.pack.cap} onClick={() => go('/billing/ai-pack')}>
              {t('billing.packBuy', { n: o.pack.replies.toLocaleString(), sum: o.pack.priceUah.toLocaleString() })}
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
                    <td>{p.kind === 'AI_PACK' ? t('billing.kindPack') : t('billing.kindPlan', { plan: p.plan === 'PRO' ? t('billing.pro') : p.plan === 'START' ? t('billing.start') : (p.plan ?? '') })}</td>
                    <td>{money(p.amountMinor)}</td>
                    <td><Badge tone={p.status === 'PAID' ? 'green' : p.status === 'FAILED' || p.status === 'REVERSED' ? 'red' : 'amber'}>{t(p.status === 'PAID' ? 'billing.st.PAID' : p.status === 'FAILED' ? 'billing.st.FAILED' : p.status === 'REVERSED' ? 'billing.st.REVERSED' : 'billing.st.PENDING')}</Badge></td>
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
