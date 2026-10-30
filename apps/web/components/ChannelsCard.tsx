'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useConfirm } from './ConfirmDialog';
import { Alert, Badge, Card } from './ui';

interface Status {
  connected: boolean;
  username: string | null;
  linkedPatients: number;
  serverReady: boolean;
}
interface All {
  messenger: Status;
  whatsapp: Status;
  viber: Status;
}

// Facebook Messenger, WhatsApp and Viber of the clinic. The accounts belong to the clinic; we only keep their access keys, encrypted.
export function ChannelsCard() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [data, setData] = useState<All | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [fbToken, setFbToken] = useState('');
  const [waToken, setWaToken] = useState('');
  const [waNumber, setWaNumber] = useState('');

  const load = useCallback(() => api<All>('/automations/channels').then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return null;

  const off = (path: string, name: string) => async () => (await ask(t('ch.disconnectConfirm', { name }), { danger: true, confirmLabel: t('ch.disconnect') })) && act(() => api(path, { method: 'DELETE' }));
  const status = (s: Status) => (
    <p className="rule">
      <Badge tone="green">{t('au.igConnected')}</Badge> {s.username ? `${s.username} · ` : ''}{t('ch.linked', { n: s.linkedPatients })}
      {!s.serverReady && <Alert tone="warn">{t('ch.serverNotReady')}</Alert>}
    </p>
  );

  return (
    <>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      <Card title="Facebook Messenger">
        {data.messenger.connected ? (
          <>
            {status(data.messenger)}
            <p className="rule">{t('ch.metaRules')}</p>
            <button className="btn" disabled={busy} onClick={off('/automations/messenger', 'Messenger')}>{t('ch.disconnect')}</button>
          </>
        ) : (
          <>
            <p className="rule">{t('ch.fbIntro')}</p>
            <div className="toolbar">
              <input className="input grow" type="password" value={fbToken} onChange={(e) => setFbToken(e.target.value)} placeholder={t('ch.fbToken')} autoComplete="off" />
              <button className="btn btn-primary" disabled={busy || fbToken.trim().length < 20} onClick={() => act(async () => { await api('/automations/messenger', { method: 'POST', body: JSON.stringify({ token: fbToken }) }); setFbToken(''); }, t('ch.connected'))}>{t('au.tgConnect')}</button>
            </div>
          </>
        )}
      </Card>

      <Card title="WhatsApp">
        {data.whatsapp.connected ? (
          <>
            {status(data.whatsapp)}
            <p className="rule">{t('ch.waRules')}</p>
            <button className="btn" disabled={busy} onClick={off('/automations/whatsapp', 'WhatsApp')}>{t('ch.disconnect')}</button>
          </>
        ) : (
          <>
            <p className="rule">{t('ch.waIntro')}</p>
            <div className="toolbar">
              <input className="input grow" value={waNumber} onChange={(e) => setWaNumber(e.target.value.replace(/\D/g, ''))} placeholder={t('ch.waNumber')} inputMode="numeric" autoComplete="off" />
              <input className="input grow" type="password" value={waToken} onChange={(e) => setWaToken(e.target.value)} placeholder={t('ch.waToken')} autoComplete="off" />
              <button className="btn btn-primary" disabled={busy || waToken.trim().length < 20 || waNumber.length < 5} onClick={() => act(async () => { await api('/automations/whatsapp', { method: 'POST', body: JSON.stringify({ token: waToken, phoneNumberId: waNumber }) }); setWaToken(''); setWaNumber(''); }, t('ch.connected'))}>{t('au.tgConnect')}</button>
            </div>
          </>
        )}
      </Card>

      <Card title="Viber">
        {data.viber.connected ? (
          <>
            {status(data.viber)}
            <button className="btn" disabled={busy} onClick={off('/automations/viber', 'Viber')}>{t('ch.disconnect')}</button>
          </>
        ) : (
          <p className="rule">{data.viber.serverReady ? t('ch.viberReady') : t('ch.viberSoon')}</p>
        )}
      </Card>
    </>
  );
}
