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
  url: string | null;
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

// Settings → Channels → Website: the enquiries from the clinic's own website forms. Two ways in: a browser page with the PUBLIC form key (only from the
// listed sites; lanka-forms.js for the forms the installer marks) and the website's server with the SECRET (the owner creates it; shown once, then only its
// last four characters). "Configured" (on, with a site) is told apart from "verified" (a real enquiry was accepted).
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
      setS((cur) => ({ ...next, canManageSecret: cur?.canManageSecret }));
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
  const state = !s.enabled ? <Badge>{t('wc.off')}</Badge> : s.verifiedAt ? <Badge tone="green">{t('site.verified')}</Badge> : <Badge tone="amber">{t('site.configured')}</Badge>;

  return (
    <Card title={t('ld.title')} actions={state}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('ld.intro')}</p>
      <p className="muted" style={{ margin: '4px 0 12px' }}>
        {s.verifiedAt ? t('ld.verifiedAt', { d: fmtDateTime(s.verifiedAt), last: fmtDateTime(s.lastReceivedAt) }) : s.enabled ? t('ld.notVerified') : t('ld.offHint')}
      </p>
      <label className="field">
        <span>{t('ld.origins')}</span>
        <textarea className="input" rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://your-clinic.com" />
      </label>
      <div className="toolbar">
        <button className="btn" disabled={busy} onClick={() => call('/automations/leads', 'PATCH', { origins: list() }, t('wc.saved'))}>{t('common.save')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => call('/automations/leads', 'PATCH', { enabled: !s.enabled, origins: list() }, s.enabled ? t('ld.offDone') : t('ld.onDone'))}>
          {s.enabled ? t('ld.turnOff') : t('ld.turnOn')}
        </button>
      </div>

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
      <p className="muted" style={{ fontSize: 13 }}>{t('ld.meta')}</p>
    </Card>
  );
}
