'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card, Loading } from './ui';
import { ChannelsCard } from './ChannelsCard';
import { LeadsCard } from './LeadsCard';
import { MetaLoginCard } from './MetaLoginCard';
import { QrCode } from './QrCode';
import { WebChatCard } from './WebChatCard';
import { useConfirm } from './ConfirmDialog';
import { LineTabs } from './LineTabs';
import { ProHint } from './ProHint';

const CH_TABS = ['telegram', 'meta'] as const;
type ChTab = (typeof CH_TABS)[number];

interface Overview {
  telegram: { connected: boolean; username: string | null; linkedPatients: number; staffChat: string | null };
  instagram: { connected: boolean; username: string | null; linkedPatients: number; serverReady: boolean; oauthReady: boolean; facebookLoginReady: boolean; via: string | null; tokenProblem: string | null };
}

// Settings → "Channels", in two tabs: Telegram (the bot, the staff chat and the manager's digest), and Instagram and Facebook (one shared Facebook login above
// them, as the server connects both with it). The tab is kept in the address (?ch=meta); the return from a Facebook or Instagram login opens the second one. Every state comes from the server (`/automations`), never from a local toggle. Channels not offered yet (WhatsApp, Viber, the website chat,
// lead forms) appear only when one is already connected or on, so it can still be managed.
export function ChannelSettings() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const [igToken, setIgToken] = useState('');
  const [link, setLink] = useState('');
  const [staffCode, setStaffCode] = useState<string | null>(null);
  const [ch, setCh] = useState<ChTab>('telegram');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('ch') === 'meta' || q.has('ig') || q.has('meta')) setCh('meta');
  }, []);
  const pickCh = (k: ChTab) => {
    setCh(k);
    const q = new URLSearchParams(window.location.search);
    if (k === 'telegram') q.delete('ch');
    else q.set('ch', k);
    window.history.replaceState(null, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}`);
  };

  const load = useCallback(() => {
    api<Overview>('/automations').then(setData).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  // the shared link to the bot (for a QR code at the reception)
  useEffect(() => {
    if (data?.telegram.connected) api<{ url: string }>('/automations/telegram/link').then((r) => setLink(r.url)).catch(() => undefined);
    else setLink('');
  }, [data?.telegram.connected]);

  useEffect(() => {
    if (!info) return;
    const id = setTimeout(() => setInfo(''), 6000);
    return () => clearTimeout(id);
  }, [info]);

  // the return from the Instagram login (?ig=...): only that parameter is removed from the address
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const code = q.get('ig');
    if (!code) return;
    const bad: Record<string, string> = { denied: t('au.igDenied'), fail: t('au.igFail'), taken: t('au.igTaken'), plan: t('au.igPlan'), off: t('au.igOff'), demo: t('au.igFail') };
    if (code === 'ok') setInfo(t('au.igDone'));
    else setError(bad[code] ?? t('au.igFail'));
    q.delete('ig');
    window.history.replaceState(null, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}`);
  }, [t]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  const tg = data.telegram;
  // a bot that was connected before and is not now: its patients' links are kept, and they work again after a new connection
  const tgWasConnected = !tg.connected && tg.linkedPatients > 0;

  return (
    <>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      <LineTabs id="chan" label={t('set.tab.channels')} tabs={CH_TABS} active={ch} onPick={pickCh} render={(k) => t(`chs.tab.${k}`)} />

      {ch === 'telegram' && (
      <div role="tabpanel" id="chan-panel-telegram" aria-labelledby="chan-tab-telegram">
      <Card title={t('au.tgTitle')} actions={<Badge tone={tg.connected ? 'green' : tgWasConnected ? 'amber' : 'gray'}>{tg.connected ? t('au.tgConnected') : tgWasConnected ? t('chs.tgDisconnected') : t('chs.notConnected')}</Badge>}>
        {tg.connected ? (
          <>
            <p className="rule">@{tg.username} · {t('au.tgLinked', { n: tg.linkedPatients })}</p>
            <p className="rule">{t('au.tgHowPatients')}</p>
            {link && (
              <div className="toolbar" style={{ alignItems: 'flex-start', gap: 20 }}>
                <QrCode value={link} label={t('au.tgQr')} />
                <div style={{ minWidth: 0 }}>
                  <p className="rule" style={{ marginTop: 0 }}>{t('au.tgQrHint')}</p>
                  <input className="input" style={{ width: '100%', maxWidth: 420 }} readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={t('au.tgQr')} />
                </div>
              </div>
            )}
            <section className="rule-card" style={{ marginTop: 12 }}>
              <b>{t('au.staffTitle')}</b>
              <p className="rule" style={{ margin: '4px 0 8px' }}>{t('au.staffIntro')}</p>
              {tg.staffChat ? (
                <>
                  <p className="rule"><Badge tone="green">{t('au.staffOn')}</Badge> {tg.staffChat}</p>
                  <div className="toolbar">
                    <button className="btn btn-sm" disabled={busy} onClick={() => act(async () => { const r = await api<{ sent: boolean }>('/automations/telegram/staff-chat/test', { method: 'POST' }); if (!r.sent) throw new Error(t('au.staffTestFail')); }, t('au.staffTestOk'))}>{t('au.staffTest')}</button>
                    <button className="btn btn-sm" disabled={busy} onClick={async () => (await ask(t('au.staffOffConfirm'), { danger: true, confirmLabel: t('au.staffOff') })) && act(async () => { await api('/automations/telegram/staff-chat', { method: 'DELETE' }); setStaffCode(null); })}>{t('au.staffOff')}</button>
                  </div>
                </>
              ) : staffCode ? (
                <>
                  <ol className="terms-list">
                    <li>{t('au.staffStep1', { bot: tg.username ?? '' })}</li>
                    <li>{t('au.staffStep2')}</li>
                  </ol>
                  <input className="input" style={{ width: '100%', maxWidth: 320 }} readOnly value={`/chat ${staffCode}`} onFocus={(e) => e.currentTarget.select()} aria-label={t('au.staffCmd')} />
                  <p className="muted" style={{ fontSize: 13 }}>{t('au.staffCodeHint')}</p>
                  <div className="toolbar">
                    <button className="btn btn-sm" disabled={busy} onClick={() => { setStaffCode(null); load(); }}>{t('au.staffCheck')}</button>
                  </div>
                </>
              ) : (
                <div className="toolbar">
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(async () => { const r = await api<{ code: string }>('/automations/telegram/staff-chat', { method: 'POST' }); setStaffCode(r.code); })}>{t('au.staffOn2')}</button>
                </div>
              )}
            </section>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <button className="btn" disabled={busy} onClick={async () => (await ask(t('au.tgDisconnectConfirm'), { danger: true, confirmLabel: t('au.tgDisconnect') })) && act(() => api('/automations/telegram', { method: 'DELETE' }))}>
                {t('au.tgDisconnect')}
              </button>
            </div>
          </>
        ) : (
          <>
            {tgWasConnected && <Alert tone="warn">{t('chs.tgWasConnected', { n: tg.linkedPatients })}</Alert>}
            <p className="rule">{t('au.tgIntro')}</p>
            <ol className="terms-list">
              <li>{t('au.tgStep1')}</li>
              <li>{t('au.tgStep2')}</li>
              <li>{t('au.tgStep3')}</li>
            </ol>
            <div className="toolbar">
              <input className="input grow" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('au.tgToken')} autoComplete="off" aria-label={t('au.tgToken')} />
              <button className="btn btn-primary" disabled={busy || token.trim().length < 20} onClick={() => act(async () => { await api('/automations/telegram', { method: 'POST', body: JSON.stringify({ token }) }); setToken(''); }, t('au.tgDone'))}>
                {t('au.tgConnect')}
              </button>
            </div>
          </>
        )}
      </Card>

      <p className="rule">{t('chs.digestMoved')} <a href="/insights">{t('chs.digestLink')}</a></p>
      </div>
      )}

      {ch === 'meta' && (
      <div role="tabpanel" id="chan-panel-meta" aria-labelledby="chan-tab-meta">
      <ProHint feature="multi_channel" />
      {/* Instagram and Messenger: one Facebook login connects the clinic's page (Messenger) and its Instagram account; each channel keeps its own card */}
      <MetaLoginCard compact ready={data.instagram.facebookLoginReady} connected={data.instagram.connected} via={data.instagram.via} account={data.instagram.username} tokenProblem={data.instagram.tokenProblem} onChanged={load} />

      <Card title={t('au.igTitle')} actions={<Badge tone={data.instagram.connected ? 'green' : 'gray'}>{data.instagram.connected ? t('au.igConnected') : t('chs.notConnected')}</Badge>}>
        {data.instagram.connected ? (
          <>
            <p className="rule">{data.instagram.username ? `@${data.instagram.username} · ` : ''}{t('au.igLinked', { n: data.instagram.linkedPatients })}</p>
            <p className="rule">{t('au.igHow')}</p>
            {!data.instagram.serverReady && <Alert tone="warn">{t('au.igNotReady')}</Alert>}
            <div className="toolbar" style={{ marginTop: 12 }}>
              <button className="btn" disabled={busy} onClick={async () => (await ask(t('au.igDisconnectConfirm'), { danger: true, confirmLabel: t('au.igDisconnect') })) && act(() => api('/automations/instagram', { method: 'DELETE' }))}>
                {t('au.igDisconnect')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="rule">{t('au.igIntro')}</p>
            <p className="muted">{t('au.igConnectHint')}</p>
            {data.instagram.oauthReady ? (
              <div className="toolbar" style={{ marginTop: 12 }}>
                <a className="btn btn-primary" href="/backend/automations/instagram/oauth">{t('au.igConnect')}</a>
              </div>
            ) : (
              <Alert tone="warn">{t('au.igOff')}</Alert>
            )}
            <details className="more-details" style={{ marginTop: 12 }}>
              <summary>{t('au.igManual')}</summary>
              <div className="toolbar" style={{ marginTop: 8 }}>
                <input className="input grow" type="password" value={igToken} onChange={(e) => setIgToken(e.target.value)} placeholder={t('au.igToken')} autoComplete="off" aria-label={t('au.igToken')} />
                <button className="btn btn-primary" disabled={busy || igToken.trim().length < 20} onClick={() => act(async () => { await api('/automations/instagram', { method: 'POST', body: JSON.stringify({ token: igToken }) }); setIgToken(''); }, t('au.igDone'))}>
                  {t('au.igConnect')}
                </button>
              </div>
            </details>
          </>
        )}
      </Card>

      <ChannelsCard />
      </div>
      )}

      {/* the website chat and lead forms are not offered yet: shown under both tabs only while one is on */}
      <WebChatCard onlyIfEnabled />
      <LeadsCard onlyIfEnabled />
    </>
  );
}
