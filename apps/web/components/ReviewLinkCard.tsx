'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Card } from './ui';

// The link a pleased patient is invited to leave a public review at (the "ask for a rating after the visit" rule uses it). It is set here, next to the
// rules; "Quality" only shows the results. The same setting as before (/reviews/settings).
export function ReviewLinkCard() {
  const { t } = useI18n();
  const [saved, setSaved] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<{ settings: { reviewUrl: string | null } }>('/reviews?months=1')
        .then((d) => {
          setSaved(d.settings.reviewUrl ?? '');
          setUrl(d.settings.reviewUrl ?? '');
        })
        .catch((e) => setError((e as Error).message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await api('/reviews/settings', { method: 'PATCH', body: JSON.stringify({ reviewUrl: url.trim() }) });
      setInfo(t('common.saved'));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (saved === null && !error) return null;
  return (
    <Card title={t('q.reviewLink')}>
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('q.reviewLinkHint')}</p>
      <div className="toolbar">
        <input className="input grow" type="url" inputMode="url" placeholder="https://g.page/r/…/review" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={300} aria-label={t('q.reviewLink')} />
        <button className="btn" disabled={busy || url.trim() === (saved ?? '')} onClick={save}>{t('common.save')}</button>
      </div>
    </Card>
  );
}
