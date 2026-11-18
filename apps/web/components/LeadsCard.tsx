'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtDateTime } from '../lib/ui';
import { useConfirm } from './ConfirmDialog';
import { Alert, Badge, Card } from './ui';
import { WebsiteCode, WebsiteRequest } from './WebsiteCode';

interface Settings {
  enabled: boolean;
  origins: string[];
  formKey: string | null;
  serverUrl: string;
  snippet: string | null;
  formPage: string | null;
  request: WebsiteRequest | null;
  requestReceivedAt: string | null;
  secret: { set: boolean; hint: string | null };
  verifiedAt: string | null;
  lastReceivedAt: string | null;
  canManageSecret?: boolean;
  canRequest?: boolean;
}

// Intake can be on before any form has been installed. Verification comes from the first received enquiry.
export function LeadsCard() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [s, setS] = useState<Settings | null>(null);
  const [origins, setOrigins] = useState('');
  const [website, setWebsite] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<Settings>('/automations/leads')
        .then((r) => {
          setS(r);
          setOrigins(r.origins.join('\n'));
          setWebsite(r.request?.websiteOrigin ?? r.formPage ?? r.origins[0] ?? '');
        })
        .catch((e) => setError((e as Error).message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function call<T = Settings>(path: string, method: string, body: object | undefined, ok: string, pick?: (r: T) => Settings) {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const r = await api<T>(path, { method, body: body ? JSON.stringify(body) : undefined });
      const next = pick ? pick(r) : (r as unknown as Settings);
      setS((cur) => ({ ...next, canManageSecret: next.canManageSecret ?? cur?.canManageSecret, canRequest: next.canRequest ?? cur?.canRequest }));
      setInfo(ok);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function requestConnection() {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const request = await api<WebsiteRequest>('/automations/leads/connection-request', { method: 'POST', body: JSON.stringify({ website: website.trim() }) });
      setS((cur) => cur && { ...cur, request });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!s) return error ? <Alert tone="error">{error}</Alert> : null;
  const list = () => origins.split(/[\s,]+/).filter(Boolean);
  const intake = <Badge tone={s.enabled ? 'green' : 'gray'}>{t(s.enabled ? 'ld.ready' : 'ld.intakeOff')}</Badge>;
  const receivedAt = s.request ? s.requestReceivedAt : s.lastReceivedAt ?? s.verifiedAt;
  const page = s.formPage;
  const code = s.snippet;
  const prepared = !!code && !!page;
  const canRequest = s.canRequest && !s.request && !prepared && !receivedAt;
  const displayedWebsite = s.request?.websiteOrigin ?? page ?? s.origins[0];

  return (
    <Card title={t('ld.title')} actions={intake}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      {canRequest ? (
        <form onSubmit={(e) => { e.preventDefault(); void requestConnection(); }}>
          <label className="field">
            <span>{t('ld.origins')}</span>
            <input className="input" type="url" required maxLength={200} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://example.com" />
          </label>
          <p>{t('ld.assistedIntro')}</p>
          <p className="muted">{t('ld.orderNext')}</p>
          <button className="btn btn-primary" disabled={busy || !website.trim()}>{t('ld.order')}</button>
        </form>
      ) : displayedWebsite && <p style={{ overflowWrap: 'anywhere' }}>{t('ld.origins')} · {displayedWebsite}</p>}

      {s.request && (
        <section className="rule-card" style={{ marginTop: 14 }} aria-live="polite">
          <strong>{t(s.request.handledAt ? 'ld.requestComplete' : s.request.installedAt ? 'ld.requestInstalled' : 'ld.requestReceived')}</strong>
          {!s.request.handledAt && !s.request.installedAt && !prepared && <p className="muted" style={{ margin: '8px 0 0' }}>{t('ld.orderNext')}</p>}
        </section>
      )}
      {code && page && (
        <section className="rule-card" style={{ marginTop: 14 }}>
          <h3>{t('ld.installCode')}</h3>
          <WebsiteCode key={code} code={code} page={page} />
        </section>
      )}
      {(receivedAt || prepared) && (
        <section className="rule-card" style={{ marginTop: 14 }}>
          <div className="toolbar spread">
            <strong>{t('ld.verification')}</strong>
            <span role="status"><Badge tone={receivedAt ? 'green' : 'amber'}>{t(receivedAt ? 'ld.receivedVerified' : 'ld.awaiting')}</Badge></span>
          </div>
          {receivedAt ? (
            <p className="muted" style={{ margin: '8px 0 0' }}>{t('ld.receivedAt', { d: fmtDateTime(receivedAt) })}</p>
          ) : s.enabled && <p style={{ margin: '8px 0 0' }}>{t('ld.testForm')}</p>}
          {receivedAt && s.lastReceivedAt && <a className="btn" href="/inquiries" style={{ marginTop: 8 }}>{t('ld.inquiries')}</a>}
        </section>
      )}

      <div className="toolbar" style={{ marginTop: 14 }}>
        <button className="btn" disabled={busy} onClick={() => call('/automations/leads', 'PATCH', { enabled: !s.enabled }, s.enabled ? t('ld.offDone') : t('ld.onDone'))}>{t(s.enabled ? 'ld.turnOff' : 'ld.turnOn')}</button>
        {(s.request || prepared || receivedAt) && <button className="btn" disabled={busy} onClick={() => call('/automations/leads', 'GET', undefined, '')}>{t('ld.refreshStatus')}</button>}
      </div>
      <details className="more-details website-developer-guide">
        <summary>{t('ld.developerInstructions')}</summary>
        <p>{t('ld.browserDeveloper')}</p>
        <section className="rule-card">
          <label className="field">
            <span>{t('ld.allowedOrigins')}</span>
            <textarea className="input" rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} />
          </label>
          {s.formKey && (
            <label className="field">
              <span>{t('ld.publicKey')}</span>
              <input className="input" readOnly value={s.formKey} onFocus={(e) => e.currentTarget.select()} />
            </label>
          )}
          <div className="toolbar">
            <button className="btn" disabled={busy} onClick={() => call('/automations/leads', 'PATCH', { origins: list() }, t('common.saved'))}>{t('common.save')}</button>
            {s.formKey && (
              <button
                className="btn"
                disabled={busy}
                onClick={async () => (await ask(t('ld.rotateConfirm'), { danger: true, confirmLabel: t('wc.rotate') })) && call('/automations/leads/rotate-key', 'POST', undefined, t('ld.rotated'))}
              >
                {t('ld.rotatePublicKey')}
              </button>
            )}
          </div>
        </section>
        <section className="rule-card" style={{ marginTop: 14 }}>
          <b>{t('ld.serverTitle')}</b>
          <p className="muted" style={{ fontSize: 13, margin: '4px 0' }}>{t('ld.serverHint')}</p>
          <input className="input" style={{ width: '100%' }} readOnly value={s.serverUrl} onFocus={(e) => e.currentTarget.select()} aria-label={t('ld.serverUrl')} />
          <p style={{ margin: '8px 0' }}>{s.secret.set ? t('ld.secretSet', { hint: s.secret.hint ?? '' }) : t('ld.secretNone')}</p>
          {secret && (
            <>
              <Alert tone="warn">{t('ld.secretOnce')}</Alert>
              <input className="input" readOnly value={secret} onFocus={(e) => e.currentTarget.select()} aria-label={t('ld.serverTitle')} />
            </>
          )}
          {s.canManageSecret ? (
            <div className="toolbar" style={{ marginTop: 8 }}>
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={async () => {
                  if (s.secret.set && !(await ask(t('ld.secretRenewConfirm'), { danger: true, confirmLabel: t('ld.secretNew') }))) return;
                  const r = await call<{ secret: string; settings: Settings }>('/automations/leads/secret', 'POST', undefined, t('ld.secretCreated'), (x) => x.settings);
                  if (r) setSecret(r.secret);
                }}
              >
                {s.secret.set ? t('ld.secretNew') : t('ld.secretCreate')}
              </button>
              {s.secret.set && (
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    if (!(await ask(t('ld.secretRevokeConfirm'), { danger: true, confirmLabel: t('ld.secretRevoke') }))) return;
                    setSecret('');
                    await call('/automations/leads/secret', 'DELETE', undefined, t('ld.secretRevoked'));
                  }}
                >
                  {t('ld.secretRevoke')}
                </button>
              )}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>{t('ld.secretOwnerOnly')}</p>
          )}
        </section>
      </details>
    </Card>
  );
}
