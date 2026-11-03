'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { Alert, Card } from './ui';

interface Contacts {
  address: string;
  phone: string;
  directions: string;
}

// What the chat assistant tells patients who ask "where are you" and "what is your phone". Cliniccards does not give these to us.
export function ClinicContacts() {
  const t = useT();
  const [c, setC] = useState<Contacts | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Contacts>('/clinic/contacts').then(setC).catch((e) => setError((e as Error).message));
  }, []);

  if (!c) return error ? <Alert tone="error">{error}</Alert> : null;
  const set = (patch: Partial<Contacts>) => {
    setSaved(false);
    setC({ ...c, ...patch });
  };

  async function save() {
    setBusy(true);
    setError('');
    try {
      setC(await api<Contacts>('/clinic/contacts', { method: 'PUT', body: JSON.stringify(c) }));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('cc.title')}>
      <p className="rule">{t('cc.hint')}</p>
      {error && <Alert tone="error">{error}</Alert>}
      <label className="field"><span>{t('cc.address')}</span><input className="input" value={c.address} maxLength={300} onChange={(e) => set({ address: e.target.value })} placeholder={t('cc.addressPh')} /></label>
      <label className="field"><span>{t('cc.phone')}</span><input className="input" type="tel" value={c.phone} maxLength={40} onChange={(e) => set({ phone: e.target.value })} placeholder="+380…" /></label>
      <label className="field"><span>{t('cc.directions')}</span><textarea className="input" rows={3} value={c.directions} maxLength={500} onChange={(e) => set({ directions: e.target.value })} placeholder={t('cc.directionsPh')} /></label>
      <div className="toolbar">
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? t('common.wait') : t('common.save')}</button>
        {saved && <span className="muted">{t('common.saved')}</span>}
      </div>
    </Card>
  );
}
