'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useConfirm } from './ConfirmDialog';
import { Alert, Badge, Card } from './ui';

interface Settings {
  enabled: boolean;
  origins: string[];
  greeting: string | null;
  snippet: string | null;
}

// The chat widget for the clinic's own website: switch, allowed site addresses, greeting and the code to paste into the site
export function WebChatCard() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [s, setS] = useState<Settings | null>(null);
  const [origins, setOrigins] = useState('');
  const [greeting, setGreeting] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<Settings>('/automations/webchat')
        .then((r) => {
          setS(r);
          setOrigins(r.origins.join('\n'));
          setGreeting(r.greeting ?? '');
        })
        .catch((e) => setError((e as Error).message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function save(patch: object, ok: string) {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const r = await api<Settings>('/automations/webchat', { method: 'PATCH', body: JSON.stringify(patch) });
      setS(r);
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
    <Card title={t('wc.title')} actions={s.enabled ? <Badge tone="green">{t('wc.on')}</Badge> : <Badge>{t('wc.off')}</Badge>}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('wc.intro')}</p>
      <label className="field">
        <span>{t('wc.origins')}</span>
        <textarea className="input" rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://your-clinic.com" />
      </label>
      <label className="field">
        <span>{t('wc.greeting')}</span>
        <input className="input" maxLength={300} value={greeting} onChange={(e) => setGreeting(e.target.value)} />
      </label>
      <div className="toolbar">
        <button className="btn" disabled={busy} onClick={() => save({ origins: list(), greeting }, t('wc.saved'))}>{t('common.save')}</button>
        <button className="btn btn-primary" disabled={busy || (!s.enabled && list().length === 0)} onClick={() => save({ enabled: !s.enabled, origins: list(), greeting }, s.enabled ? t('wc.offDone') : t('wc.onDone'))}>
          {s.enabled ? t('wc.turnOff') : t('wc.turnOn')}
        </button>
      </div>
      {s.snippet && (
        <>
          <p className="rule">{t('wc.snippet')}</p>
          <input className="input" readOnly value={s.snippet} onFocus={(e) => e.currentTarget.select()} aria-label={t('wc.snippet')} />
          <div className="toolbar" style={{ marginTop: 8 }}>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                if (!(await ask(t('wc.rotateConfirm'), { danger: true, confirmLabel: t('wc.rotate') }))) return;
                try {
                  setS(await api<Settings>('/automations/webchat/rotate-key', { method: 'POST' }));
                  setInfo(t('wc.rotated'));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {t('wc.rotate')}
            </button>
          </div>
        </>
      )}
      <p className="muted" style={{ fontSize: 13 }}>{t('wc.note')}</p>
    </Card>
  );
}
