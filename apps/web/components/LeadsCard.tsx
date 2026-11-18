'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtDateTime } from '../lib/ui';
import { useConfirm } from './ConfirmDialog';
import { Alert, Badge, Card } from './ui';

interface Settings {
  enabled: boolean;
  origins: string[];
  formKey: string | null;
  serverUrl: string;
  snippet: string | null;
  formConfig: { page: string; selector: string; formId: string; fields: Record<string, string> } | null;
  secret: { set: boolean; hint: string | null };
  verifiedAt: string | null;
  lastReceivedAt: string | null;
  canManageSecret?: boolean;
}

const configText = (config: Settings['formConfig']) => config ? JSON.stringify(config, null, 2) : '';

// Intake can be on before any form has been installed. Verification comes from the first received enquiry.
export function LeadsCard() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [s, setS] = useState<Settings | null>(null);
  const [origins, setOrigins] = useState('');
  const [configuration, setConfiguration] = useState('');
  const [secret, setSecret] = useState('');
  const [copyStatus, setCopyStatus] = useState<'copied' | 'copyFailed' | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<Settings>('/automations/leads')
        .then((r) => {
          setS(r);
          setOrigins(r.origins.join('\n'));
          setConfiguration(configText(r.formConfig));
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
    setCopyStatus(null);
    try {
      const r = await api<T>(path, { method, body: body ? JSON.stringify(body) : undefined });
      const next = pick ? pick(r) : (r as unknown as Settings);
      setS((cur) => ({ ...next, canManageSecret: next.canManageSecret ?? cur?.canManageSecret }));
      setInfo(ok);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveConfiguration() {
    let formConfig: unknown;
    try {
      formConfig = configuration.trim() ? JSON.parse(configuration) : null;
    } catch {
      setInfo('');
      setError(t('ld.formConfigInvalid'));
      return;
    }
    const next = await call('/automations/leads', 'PATCH', { formConfig }, t('common.saved'));
    if (next) setConfiguration(configText(next.formConfig));
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('copyFailed');
    }
  }
  if (!s) return error ? <Alert tone="error">{error}</Alert> : null;
  const list = () => origins.split(/[\s,]+/).filter(Boolean);
  const intake = <Badge tone={s.enabled ? 'green' : 'gray'}>{t(s.enabled ? 'ld.ready' : 'ld.intakeOff')}</Badge>;
  const receivedAt = s.lastReceivedAt ?? s.verifiedAt;
  const page = s.formConfig?.page;
  const code = s.snippet;

  return (
    <Card title={t('ld.title')} actions={intake}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <label className="field">
        <span>{t('ld.origins')}</span>
        <textarea className="input" rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://your-clinic.com" />
      </label>
      <div className="toolbar">
        <button className="btn" disabled={busy} onClick={() => call('/automations/leads', 'PATCH', { origins: list() }, t('wc.saved'))}>{t('common.save')}</button>
        <button className={s.enabled ? 'btn' : 'btn btn-primary'} disabled={busy} onClick={() => call('/automations/leads', 'PATCH', { enabled: !s.enabled, origins: list() }, s.enabled ? t('ld.offDone') : t('ld.onDone'))}>
          {s.enabled ? t('ld.turnOff') : t('ld.turnOn')}
        </button>
      </div>

      <section className="rule-card" style={{ marginTop: 14 }}>
        <h3>{t('ld.installCode')}</h3>
        {code && page ? (
          <>
            <p style={{ margin: '8px 0' }}>{t('ld.installHint')}</p>
            <pre className="code-sample" tabIndex={0} aria-label={t('ld.installCode')}><code>{code}</code></pre>
            <div className="toolbar" style={{ marginTop: 8 }}>
              <button className="btn btn-primary" disabled={busy} onClick={() => copyCode(code)}>{t('ld.copyCode')}</button>
              {copyStatus && <span className="muted" role="status">{t(`ld.${copyStatus}`)}</span>}
            </div>
            <p className="muted" style={{ margin: '8px 0 0', overflowWrap: 'anywhere' }}>
              {t(new URL(page).pathname === '/' ? 'ld.elementorHome' : 'ld.elementorPage', { page })}
            </p>
          </>
        ) : <p className="muted" style={{ margin: '8px 0 0' }}>{t('ld.codeNotReady')}</p>}
      </section>

      <section className="rule-card" style={{ marginTop: 14 }}>
        <div className="toolbar spread">
          <strong>{t('ld.verification')}</strong>
          <span role="status"><Badge tone={receivedAt ? 'green' : 'amber'}>{t(receivedAt ? 'ld.received' : 'ld.awaiting')}</Badge></span>
        </div>
        {receivedAt ? (
          <p className="muted" style={{ margin: '8px 0 0' }}>{t('ld.receivedAt', { d: fmtDateTime(receivedAt) })}</p>
        ) : s.enabled && <p style={{ margin: '8px 0 0' }}>{t('ld.testForm')}</p>}
        {(s.enabled || s.lastReceivedAt) && (
          <div className="toolbar" style={{ marginTop: 8 }}>
            {s.enabled && <button className="btn" disabled={busy} onClick={() => call('/automations/leads', 'GET', undefined, '')}>{t('ld.refreshStatus')}</button>}
            {s.lastReceivedAt && <a className="btn" href="/inquiries">{t('ld.inquiries')}</a>}
          </div>
        )}
      </section>

      <details className="more-details website-developer-guide">
        <summary>{t('ld.technicalSettings')}</summary>
        <section className="rule-card">
          <label className="field">
            <span>{t('ld.formConfig')}</span>
            <textarea className="input" rows={6} spellCheck={false} value={configuration} onChange={(e) => setConfiguration(e.target.value)} />
          </label>
          <p className="muted" style={{ margin: '4px 0 8px' }}>{t('ld.formConfigHint')}</p>
          {s.formKey && (
            <label className="field">
              <span>{t('ld.publicKey')}</span>
              <input className="input" readOnly value={s.formKey} onFocus={(e) => e.currentTarget.select()} />
            </label>
          )}
          <div className="toolbar">
            <button className="btn" disabled={busy || configuration === configText(s.formConfig)} onClick={saveConfiguration}>{t('ld.saveFormConfig')}</button>
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
        {s.enabled && (
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
        )}
      </details>
    </Card>
  );
}
