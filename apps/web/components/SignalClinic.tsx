'use client';

import { ReactNode, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Loading } from './ui';

// A link from a signal message carries the clinic it is about (?c=<clinicId>, an id only). The session may have another clinic selected: then
// nothing of the selected clinic is shown under that link, only an offer to switch (when the person belongs to that clinic) or a refusal. The
// server still answers only for the clinic of the session, so this is about clarity, not access.
export function SignalClinic({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  // read after the first render (the server has no address bar: reading it during render would not match the server's HTML)
  const [want, setWant] = useState<string | null | undefined>(undefined);
  const [state, setState] = useState<{ current: string | null; clinics: { id: string; name: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setWant(new URLSearchParams(window.location.search).get('c'));
  }, []);
  useEffect(() => {
    if (!want) return;
    Promise.all([api<{ clinicId?: string }>('/auth/me'), api<{ id: string; name: string }[]>('/auth/clinics').catch(() => [])])
      .then(([me, clinics]) => setState({ current: me.clinicId ?? null, clinics }))
      .catch(() => setState({ current: null, clinics: [] }));
  }, [want]);

  if (want === undefined) return <Loading />;
  if (!want) return <>{children}</>;
  if (!state) return <Loading />;
  if (!state.current || want === state.current) return <>{children}</>;
  const target = state.clinics.find((c) => c.id === want);
  const here = state.clinics.find((c) => c.id === state.current);
  if (!target) return <Alert tone="warn">{t('sigd.noClinic')}</Alert>;

  const go = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/auth/switch', { method: 'POST', body: JSON.stringify({ clinicId: want }) });
      // the same page again, now in that clinic
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Alert tone="info">
      {t('sigd.otherClinic', { target: target.name, current: here?.name ?? '—' })}{' '}
      <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void go()}>{t('sigd.switchTo', { name: target.name })}</button>
      {error && <span className="err"> {error}</span>}
    </Alert>
  );
}
