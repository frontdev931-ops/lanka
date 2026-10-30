'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import Link from 'next/link';
import { Alert, Badge, Card } from './ui';

interface Overview {
  plan: string;
  limits: { users: number; messagesPerMonth: number; aiRepliesPerMonth: number };
  usage: { users: number; pendingInvitations: number; patients: number; messagesThisMonth: number; aiRepliesThisMonth: number };
  aiPurchased: number;
  require2fa: boolean;
}

const Meter = ({ label, used, limit }: { label: string; used: number; limit: number }) => (
  <div className="plan-meter">
    <div className="plan-meter-top">
      <span>{label}</span>
      <b>{used} / {limit}</b>
    </div>
    <span className="q-bar-track">
      <span className="q-bar" style={{ width: `${Math.min(100, limit ? (used / limit) * 100 : 100)}%`, opacity: used >= limit ? 0.55 : 1 }} />
    </span>
  </div>
);

// The clinic's plan, what it may use and what it has used this month; the owner can require two-factor sign-in from all staff
export function PlanCard({ isOwner }: { isOwner: boolean }) {
  const { t } = useI18n();
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<Overview>('/service/usage').then(setO).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);

  if (!o) return error ? <Alert tone="error">{error}</Alert> : null;
  const u = o.usage;
  return (
    <Card title={t('plan.title')} actions={<Badge tone="teal">{o.plan}</Badge>}>
      {error && <Alert tone="error">{error}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('plan.intro')}</p>
      <Meter label={t('plan.users')} used={u.users + u.pendingInvitations} limit={o.limits.users} />
      <Meter label={t('plan.messages')} used={u.messagesThisMonth} limit={o.limits.messagesPerMonth} />
      <Meter label={t('plan.ai')} used={u.aiRepliesThisMonth} limit={o.limits.aiRepliesPerMonth} />
      <p className="muted" style={{ fontSize: 13 }}>{t('plan.more', { patients: u.patients, bought: o.aiPurchased })} {isOwner && <Link href="/billing">{t('billing.buyAiShort')}</Link>}</p>
      {isOwner && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={o.require2fa}
            disabled={busy}
            onChange={async (e) => {
              setBusy(true);
              setError('');
              try {
                setO(await api<Overview>('/service/security', { method: 'PATCH', body: JSON.stringify({ require2fa: e.target.checked }) }));
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
          <span>
            <b>{t('plan.require2fa')}</b>
            <br />
            <span className="muted">{t('plan.require2faHint')}</span>
          </span>
        </label>
      )}
    </Card>
  );
}
