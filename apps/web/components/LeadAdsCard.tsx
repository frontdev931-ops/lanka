'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Key, useI18n } from '../lib/i18n';
import { fmtDateTime } from '../lib/ui';
import { Alert, Badge, Card } from './ui';

type State = 'plan' | 'not_connected' | 'unknown' | 'permission' | 'not_subscribed' | 'token' | 'unavailable' | 'waiting' | 'receiving';
interface Status {
  state: State;
  page: { id: string | null; name: string | null } | null;
  permission: boolean | null;
  subscribed: boolean;
  lastLeadAt: string | null;
  received30d: number;
  failed: string[];
  retrying: number;
  verified: boolean;
}

const TONE: Record<State, 'green' | 'amber' | 'red' | 'gray'> = { plan: 'gray', not_connected: 'gray', unknown: 'amber', permission: 'red', not_subscribed: 'amber', token: 'red', unavailable: 'amber', waiting: 'amber', receiving: 'green' };

// Settings → Channels → Instagram and Facebook: the clinic's Meta ad forms (Lead Ads). They arrive through the connected Facebook page; this card says what is
// connected, what is missing (the leads_retrieval permission, the page's subscription, an ended token, a form or lead Meta does not give), when the last lead
// came, and lets a manager fetch again the leads that could not be fetched (the existing retry of integration events) once the cause is fixed.
export function LeadAdsCard() {
  const { t } = useI18n();
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Status>('/automations/leads/meta').then(setS).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!s) return error ? <Alert tone="error">{error}</Alert> : null;

  async function retry() {
    setBusy(true);
    setError('');
    setInfo('');
    let ok = 0;
    for (const id of s!.failed) {
      try {
        await api(`/integration-events/${id}/retry`, { method: 'POST' });
        ok++;
      } catch {
        // still failing: it stays in the list
      }
    }
    setInfo(t('la.retried', { n: ok, all: s!.failed.length }));
    await load();
    setBusy(false);
  }

  return (
    <Card title={t('la.title')} actions={<Badge tone={TONE[s.state]}>{t(`la.badge.${s.state}` as Key)}</Badge>}>
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('la.intro')}</p>
      {s.page && <p style={{ margin: '4px 0' }}>{t('la.page', { name: s.page.name ?? s.page.id ?? '' })}</p>}
      <p className={s.state === 'receiving' ? 'muted' : undefined} style={{ margin: '4px 0' }}>{t(`la.state.${s.state}` as Key)}</p>
      {s.lastLeadAt && <p className="muted" style={{ margin: '4px 0' }}>{t('la.last', { d: fmtDateTime(s.lastLeadAt), n: s.received30d })}</p>}
      {s.retrying > 0 && <p className="muted" style={{ margin: '4px 0' }}>{t('la.retrying', { n: s.retrying })}</p>}
      {s.failed.length > 0 && (
        <>
          <Alert tone="warn">{t('la.failed', { n: s.failed.length })}</Alert>
          <div className="toolbar" style={{ marginTop: 8 }}>
            <button className="btn" disabled={busy} onClick={retry}>{t('la.retry')}</button>
          </div>
        </>
      )}
      <p className="muted" style={{ fontSize: 13 }}>{t('la.note')}</p>
    </Card>
  );
}
