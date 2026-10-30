'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useConfirm } from './ConfirmDialog';
import { Alert, Badge, Card } from './ui';

interface Settings {
  enabled: boolean;
  origins: string[];
  url: string | null;
}

// Requests from the clinic's website forms and ad forms: the address a form posts to, the sites allowed to post from a browser
export function LeadsCard() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [s, setS] = useState<Settings | null>(null);
  const [origins, setOrigins] = useState('');
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

  async function call(path: string, method: string, body: object | undefined, ok: string) {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      setS(await api<Settings>(path, { method, body: body ? JSON.stringify(body) : undefined }));
      setInfo(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!s) return null;
  const list = () => origins.split(/[\s,]+/).filter(Boolean);

  return (
    <Card title={t('ld.title')} actions={s.enabled ? <Badge tone="green">{t('wc.on')}</Badge> : <Badge>{t('wc.off')}</Badge>}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('ld.intro')}</p>
      <label className="field">
        <span>{t('ld.origins')}</span>
        <textarea className="input" rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://your-clinic.com" />
      </label>
      <div className="toolbar">
        <button className="btn" disabled={busy} onClick={() => call('/automations/leads', 'PATCH', { origins: list() }, t('wc.saved'))}>{t('common.save')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => call('/automations/leads', 'PATCH', { enabled: !s.enabled }, s.enabled ? t('ld.offDone') : t('ld.onDone'))}>{s.enabled ? t('wc.turnOff') : t('wc.turnOn')}</button>
      </div>
      {s.url && (
        <>
          <p className="rule">{t('ld.url')}</p>
          <input className="input" readOnly value={s.url} onFocus={(e) => e.currentTarget.select()} aria-label={t('ld.url')} />
          <p className="muted" style={{ fontSize: 13 }}>{t('ld.fields')}</p>
          <div className="toolbar" style={{ marginTop: 8 }}>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => (await ask(t('ld.rotateConfirm'), { danger: true, confirmLabel: t('wc.rotate') })) && call('/automations/leads/rotate-key', 'POST', undefined, t('ld.rotated'))}
            >
              {t('wc.rotate')}
            </button>
          </div>
        </>
      )}
      <p className="muted" style={{ fontSize: 13 }}>{t('ld.meta')}</p>
    </Card>
  );
}
