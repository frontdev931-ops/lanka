'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../lib/api';
import { fmtDate } from '../../../lib/ui';
import { useI18n } from '../../../lib/i18n';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';

interface Overview {
  configured: boolean;
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

const FEATURES = ['ai_autoreply', 'multi_channel', 'advanced_analytics', 'daily_digest'] as const;

// Payment page: the plan, the first payment (connection + first month), renewal, extra AI replies and the payment history.
// The card is entered on the LiqPay page; we only send the person there.
export default function BillingPage() {
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
  const active = o.status === 'ACTIVE' || o.status === 'PAST_DUE';
  const money = (minor: number) => `${(minor / 100).toLocaleString()} ${t('billing.uah')}`;
  const aiPct = o.ai.included ? Math.min(100, (o.ai.used / o.ai.included) * 100) : 100;

  return (
    <>
      <PageHeader title={t('billing.title')} subtitle={t('billing.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}
      {!o.configured && <Alert tone="warn">{t('billing.notConfigured')}</Alert>}
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

      <Card title={t('billing.aiTitle')}>
        <div className="plan-meter">
          <div className="plan-meter-top">
            <span>{t('billing.aiUsed', { used: o.ai.used, limit: o.ai.included })}</span>
            <b>{t('billing.aiLeft', { n: o.ai.remaining })}</b>
          </div>
          <span className="q-bar-track"><span className="q-bar" style={{ width: `${aiPct}%` }} /></span>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>{t('billing.aiRules', { bought: o.ai.purchased })}</p>
        <div className="toolbar">
          <button className="btn" disabled={busy || !o.configured || !active || o.pack.bought >= o.pack.cap} onClick={() => go('/billing/ai-pack')}>
            {t('billing.buyAi')}: {o.pack.replies} · {o.pack.priceUah} {t('billing.uah')}
          </button>
        </div>
        {!active && <p className="muted" style={{ fontSize: 13 }}>{t('billing.buyAiLocked')}</p>}
        {o.pack.bought >= o.pack.cap && <p className="muted" style={{ fontSize: 13 }}>{t('billing.packCap')}</p>}
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
                    <td>{p.kind === 'AI_PACK' ? t('billing.kindPack') : t('billing.kindPlan', { plan: p.plan ?? '' })}</td>
                    <td>{money(p.amountMinor)}</td>
                    <td><Badge tone={p.status === 'PAID' ? 'green' : p.status === 'FAILED' ? 'red' : 'amber'}>{t(p.status === 'PAID' ? 'billing.st.PAID' : p.status === 'FAILED' ? 'billing.st.FAILED' : 'billing.st.PENDING')}</Badge></td>
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
