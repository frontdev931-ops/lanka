'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card } from './ui';

interface Props {
  ready: boolean;
  connected: boolean;
  via: string | null;
  account: string | null;
  tokenProblem: string | null;
  onChanged: () => void;
}
interface Pending {
  id: string;
  pages: { id: string; name: string; igId: string | null; igUsername: string | null }[];
}

// Connecting the clinic's Facebook page (Messenger) and the Instagram account attached to it with one Facebook login.
// Facebook's own dialog lets the owner pick exactly which page and account to share.
export function MetaLoginCard({ ready, connected, via, account, tokenProblem, onChanged }: Props) {
  const { t } = useI18n();
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  // The return from Facebook: /automations?meta=ok|select&session=...|denied|fail|...
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const code = q.get('meta');
    if (!code) return;
    const session = q.get('session');
    window.history.replaceState(null, '', window.location.pathname);
    if (code === 'ok' || code === 'ok_instagram') {
      setInfo(code === 'ok' ? t('ml.done') : t('ml.doneIg'));
      onChanged();
    } else if (code === 'select' && session) {
      api<Pending>(`/automations/meta/pending/${encodeURIComponent(session)}`).then(setPending).catch((e) => setError((e as Error).message));
    } else {
      setError(t(`ml.err.${['denied', 'taken', 'plan', 'demo', 'off', 'nopages', 'noperm', 'subscribe'].includes(code) ? code : 'fail'}` as 'ml.err.fail'));
    }
    // runs once, on the page that Facebook sends the person back to
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function choose(pageId: string) {
    if (!pending) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ messenger: boolean }>('/automations/meta/connect', { method: 'POST', body: JSON.stringify({ sessionId: pending.id, pageId }) });
      setPending(null);
      setInfo(r.messenger ? t('ml.done') : t('ml.doneIg'));
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('ml.title')} actions={connected && via === 'facebook' ? <Badge tone={tokenProblem ? 'amber' : 'green'}>{tokenProblem ? t('ml.problem') : t('au.igConnected')}</Badge> : undefined}>
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      {tokenProblem && <Alert tone="warn">{tokenProblem === 'expiring' ? t('ml.expiring') : t('ml.invalid')}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('ml.intro')}</p>
      {connected && via === 'facebook' && account && <p className="rule">{t('ml.connectedAs', { name: account })}</p>}
      {pending && (
        <>
          <p className="rule"><b>{t('ml.pick')}</b></p>
          {pending.pages.map((p) => (
            <button key={p.id} className="btn" disabled={busy} style={{ marginTop: 6, width: '100%', justifyContent: 'flex-start' }} onClick={() => choose(p.id)}>
              {p.name}{p.igUsername ? ` · Instagram @${p.igUsername}` : ` · ${t('ml.noInstagram')}`}
            </button>
          ))}
        </>
      )}
      {!pending &&
        (ready ? (
          <div className="toolbar">
            <a className="btn btn-primary" href="/backend/automations/meta/oauth">{connected && via === 'facebook' ? t('ml.again') : t('ml.connect')}</a>
          </div>
        ) : (
          <Alert tone="warn">{t('ml.err.off')}</Alert>
        ))}
      <p className="muted" style={{ fontSize: 13 }}>{t('ml.rules')}</p>
    </Card>
  );
}
