'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card } from './ui';

interface Status {
  available: boolean;
  publicKey: string | null;
  devices: number;
}

const toKey = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

// Phone notifications about new requests from chats. They work in the installed app (and in desktop browsers); on iPhone only after "Add to Home Screen".
export function PushCard() {
  const { t } = useI18n();
  const [st, setSt] = useState<Status | null>(null);
  const [here, setHere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const load = useCallback(async () => {
    setSt(await api<Status>('/push'));
    if (supported) {
      const reg = await navigator.serviceWorker.getRegistration();
      setHere(!!(await reg?.pushManager.getSubscription()));
    }
  }, [supported]);
  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  const toggle = async () => {
    if (!st?.publicKey) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await api('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: existing.endpoint }) });
        await existing.unsubscribe();
      } else {
        if ((await Notification.requestPermission()) !== 'granted') throw new Error(t('push.denied'));
        const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(st.publicKey) });
        const j = s.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
        await api('/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) });
        setInfo(t('push.on'));
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!st) return error ? <Alert tone="error">{error}</Alert> : null;
  return (
    <Card title={t('push.title')} actions={<Badge tone={here ? 'green' : 'gray'}>{here ? t('push.thisOn') : t('push.thisOff')}</Badge>}>
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('push.intro')}</p>
      {!st.available ? (
        <Alert tone="warn">{t('push.notConfigured')}</Alert>
      ) : !supported ? (
        <Alert tone="info">{t('push.unsupported')}</Alert>
      ) : (
        <div className="toolbar">
          <button className={here ? 'btn' : 'btn btn-primary'} disabled={busy} onClick={toggle}>{here ? t('push.turnOff') : t('push.turnOn')}</button>
          {here && <button className="btn" disabled={busy} onClick={() => api<{ sent: number }>('/push/test', { method: 'POST' }).then((r) => setInfo(r.sent ? t('push.testSent') : t('push.testFail'))).catch((e) => setError((e as Error).message))}>{t('push.test')}</button>}
        </div>
      )}
    </Card>
  );
}
