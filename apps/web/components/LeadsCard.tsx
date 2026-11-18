'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtDateTime } from '../lib/ui';
import type { WebsiteRequest } from '../lib/website-requests';
import { Alert, Badge, Card } from './ui';

interface Settings {
  enabled: boolean;
  origins: string[];
  formKey: string | null;
  formPage: string | null;
  request: WebsiteRequest | null;
  secret?: { set: boolean };
  lastReceivedAt: string | null;
  canRequest?: boolean;
}

export function LeadsCard() {
  const { t } = useI18n();
  const [s, setS] = useState<Settings | null>(null);
  const [website, setWebsite] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const next = await api<Settings>('/automations/leads');
      setS(next);
      setWebsite((current) => current || next.request?.websiteOrigin || next.formPage || next.origins[0] || '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function toggleIntake(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      const next = await api<Settings>('/automations/leads', { method: 'PATCH', body: JSON.stringify({ enabled }) });
      setS((current) => ({ ...next, canRequest: next.canRequest ?? current?.canRequest }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function requestConnection() {
    setBusy(true);
    setError('');
    try {
      const request = await api<WebsiteRequest>('/automations/leads/connection-request', {
        method: 'POST', body: JSON.stringify({ website: website.trim() }),
      });
      setS((current) => current && { ...current, request });
      setWebsite(request.websiteOrigin);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!s) return error ? <Alert tone="error">{error}</Alert> : null;
  const hasSetup = !!(s.enabled || s.formKey || s.secret?.set);
  const canRequest = s.canRequest && (!s.request || s.request.handledAt);
  const displayedWebsite = s.request?.websiteOrigin ?? s.formPage ?? s.origins[0];
  const intake = hasSetup && <Badge tone={s.enabled ? 'green' : 'gray'}>{t(s.enabled ? 'ld.ready' : 'ld.intakeOff')}</Badge>;

  return (
    <Card title={t('ld.title')} actions={intake}>
      {error && <Alert tone="error">{error}</Alert>}
      {canRequest ? (
        <form onSubmit={(e) => { e.preventDefault(); void requestConnection(); }}>
          <label className="field">
            <span>{t('ld.origins')}</span>
            <input className="input" type="url" required maxLength={200} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://example.com" />
          </label>
          <button className="btn btn-primary" disabled={busy || !website.trim()}>{t('ld.order')}</button>
        </form>
      ) : displayedWebsite && <p style={{ overflowWrap: 'anywhere' }}>{t('ld.origins')} · {displayedWebsite}</p>}

      {s.request && (
        <section className="rule-card" style={{ marginTop: 14 }} aria-live="polite">
          <strong>{t(s.request.handledAt ? 'ld.requestComplete' : s.request.installedAt ? 'ld.requestInstalled' : 'ld.requestReceived')}</strong>
        </section>
      )}
      {(s.lastReceivedAt || s.request || hasSetup) && (
        <section className="rule-card" style={{ marginTop: 14 }}>
          <div className="toolbar spread" aria-live="polite">
            <strong>{s.lastReceivedAt ? t('ld.lastReceivedAt', { d: fmtDateTime(s.lastReceivedAt) }) : t('ld.awaiting')}</strong>
            {s.lastReceivedAt && <a className="btn" href="/inquiries">{t('ld.inquiries')}</a>}
          </div>
        </section>
      )}
      {(hasSetup || s.request || s.lastReceivedAt) && (
        <div className="toolbar" style={{ marginTop: 14 }}>
          {hasSetup && (
            <button className="btn" disabled={busy} onClick={() => toggleIntake(!s.enabled)}>
              {t(s.enabled ? 'ld.turnOff' : 'ld.turnOn')}
            </button>
          )}
          <button className="btn" disabled={busy} onClick={refresh}>{t('ld.refreshStatus')}</button>
        </div>
      )}
    </Card>
  );
}
