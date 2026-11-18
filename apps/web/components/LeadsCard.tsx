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
  secret: { set: boolean; hint: string | null };
  verifiedAt: string | null;
  lastReceivedAt: string | null;
  canManageSecret?: boolean;
}

const FORM_EXAMPLE = `const forward = LankaForms.capture(form, 'contact',
  'name=your-name; phone=your-phone; email=your-email; message=your-message');`;
const SERVER_EXAMPLE = (url: string) => `POST ${url}
Authorization: Bearer <secret>
Idempotency-Key: <your form entry id>
Content-Type: application/json

{"name":"…","phone":"…","email":"…","message":"…","service":"…",
 "form_id":"contact","page_url":"https://…","referrer":"https://…",
 "utm_source":"…","utm_medium":"…","utm_campaign":"…"}`;

// Intake can be on before any form has been installed. Verification comes from the first received enquiry.
export function LeadsCard() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [s, setS] = useState<Settings | null>(null);
  const [origins, setOrigins] = useState('');
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
  if (!s) return error ? <Alert tone="error">{error}</Alert> : null;
  const list = () => origins.split(/[\s,]+/).filter(Boolean);
  const intake = <Badge tone={s.enabled ? 'green' : 'gray'}>{t(s.enabled ? 'ld.ready' : 'ld.intakeOff')}</Badge>;

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
        <div className="toolbar spread">
          <strong>{t('ld.verification')}</strong>
          <Badge tone={s.verifiedAt ? 'green' : 'amber'}>{t(s.verifiedAt ? 'site.verified' : 'ld.unverified')}</Badge>
        </div>
        <p className="muted" aria-live="polite" style={{ margin: '8px 0 0' }}>
          {s.verifiedAt
            ? s.lastReceivedAt
              ? t('ld.verifiedAt', { d: fmtDateTime(s.verifiedAt), last: fmtDateTime(s.lastReceivedAt) })
              : t('ld.firstReceivedAt', { d: fmtDateTime(s.verifiedAt) })
            : t('ld.notVerified')}
        </p>
        {s.enabled && !s.verifiedAt && (
          <>
            <p style={{ margin: '8px 0' }}>{t('ld.nextStep')}</p>
            <button className="btn" disabled={busy} onClick={() => call('/automations/leads', 'GET', undefined, '')}>{t('ld.refreshStatus')}</button>
          </>
        )}
      </section>

      <details className="more-details website-developer-guide">
        <summary>{t('ld.developerGuide')}</summary>
        <p className="rule" style={{ margin: 0 }}>{t('ld.developerMethods')}</p>
        {s.enabled && (
          <section className="rule-card" style={{ marginTop: 14 }}>
            <b>{t('ld.serverTitle')}</b>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0' }}>{t('ld.serverHint')}</p>
            <pre className="code-sample">{SERVER_EXAMPLE(s.serverUrl)}</pre>
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
        {s.snippet && (
          <section className="rule-card" style={{ marginTop: 14 }}>
            <b>{t('ld.browserTitle')}</b>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0' }}>{t('ld.browserHint')}</p>
            {s.formKey && (
              <label className="field">
                <span>{t('ld.publicKey')}</span>
                <input className="input" readOnly value={s.formKey} onFocus={(e) => e.currentTarget.select()} />
              </label>
            )}
            <input className="input" readOnly value={s.snippet} onFocus={(e) => e.currentTarget.select()} aria-label={t('ld.browserTitle')} />
            <p className="muted" style={{ fontSize: 13, margin: '8px 0 4px' }}>{t('ld.markForm')}</p>
            <pre className="code-sample">{FORM_EXAMPLE}</pre>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0' }}>{t('ld.copyHint')}</p>
            <div className="toolbar" style={{ marginTop: 8 }}>
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={async () => (await ask(t('ld.rotateConfirm'), { danger: true, confirmLabel: t('wc.rotate') })) && call('/automations/leads/rotate-key', 'POST', undefined, t('ld.rotated'))}
              >
                {t('wc.rotate')}
              </button>
            </div>
          </section>
        )}
        <p className="muted" style={{ fontSize: 13 }}>{t('ld.fields')}</p>
        <p className="muted" style={{ fontSize: 13 }}>{t('ld.intro')}</p>
      </details>
    </Card>
  );
}
