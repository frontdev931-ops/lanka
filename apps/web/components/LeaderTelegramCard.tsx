'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card } from './ui';
import { Switch } from './Switch';
import { useConfirm } from './ConfirmDialog';

interface View {
  available: boolean;
  bot: string | null;
  me: { tgName: string; digest: boolean; signals: boolean; blocked: boolean; connectedAt: string } | null;
  digestTo: string[];
  signalsTo: string[];
  legacy: { digest: { id: string; name: string }[]; group: string | null };
}

// Settings → General → "Telegram for reports and signals" (#leader-telegram): the signed-in owner or manager connects their OWN Telegram to the
// shared LANKA service bot. Independent of the clinic's patient bot (Settings → Channels): connecting here never needs that bot and never
// turns on sending to patients. The two personal switches start off; the list below says who receives what in this clinic.
export function LeaderTelegramCard() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [v, setV] = useState<View | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const load = useCallback(() => api<View>('/leader-telegram').then(setV).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    void load();
  }, [load]);
  // links from "Scheduled" and "Signals" land here
  useEffect(() => {
    if (v && window.location.hash === '#leader-telegram') ref.current?.scrollIntoView({ block: 'start' });
  }, [v]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const patch = (body: object) => run(async () => setV(await api<View>('/leader-telegram', { method: 'PATCH', body: JSON.stringify(body) })));

  if (!v) return error ? <Alert tone="error">{error}</Alert> : null;
  const status = !v.available ? <Badge tone="gray">{t('ltg.unavailable')}</Badge> : v.me ? <Badge tone={v.me.blocked ? 'amber' : 'green'}>{v.me.blocked ? t('ltg.blocked') : t('ltg.connected')}</Badge> : <Badge tone="gray">{t('ltg.notConnected')}</Badge>;
  const names = (list: string[]) => (list.length ? list.join(', ') : t('ltg.nobody'));

  return (
    <div id="leader-telegram" ref={ref} style={{ scrollMarginTop: 80 }}>
      <Card title={t('ltg.title')} actions={status}>
        {dialog}
        {error && <Alert tone="error">{error}</Alert>}
        <p className="rule" style={{ marginTop: 0 }}>{t('ltg.intro')}</p>

        {!v.available ? (
          <Alert tone="info">{t('ltg.offText')}</Alert>
        ) : v.me ? (
          <>
            <p style={{ margin: '0 0 6px' }}>{t('ltg.mine', { name: v.me.tgName, bot: v.bot ?? '' })}</p>
            {v.me.blocked && <Alert tone="warn">{t('ltg.blockedText')}</Alert>}
            <Switch checked={v.me.digest} disabled={busy} onChange={(on) => void patch({ digest: on })} label={t('ltg.digest')} hint={t('ltg.digestHint')} />
            <Switch checked={v.me.signals} disabled={busy} onChange={(on) => void patch({ signals: on })} label={t('ltg.signals')} hint={t('ltg.signalsHint')} />
            <div className="toolbar">
              <button className="btn btn-sm" disabled={busy} onClick={async () => (await ask(t('ltg.offConfirm'), { danger: true, confirmLabel: t('ltg.disconnect') })) && run(async () => { setV(await api<View>('/leader-telegram', { method: 'DELETE' })); setLink(null); })}>
                {t('ltg.disconnect')}
              </button>
            </div>
          </>
        ) : link ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <ol className="rule" style={{ margin: 0, paddingLeft: 20 }}>
              <li>{t('ltg.step1', { bot: v.bot ?? '' })}</li>
              <li>{t('ltg.step2')}</li>
            </ol>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{t('ltg.linkNote')}</p>
            <div className="toolbar">
              <a className="btn btn-primary" href={link} target="_blank" rel="noreferrer">{t('ltg.open')}</a>
              <button className="btn" disabled={busy} onClick={() => run(async () => { await load(); setLink(null); })}>{t('ltg.check')}</button>
            </div>
          </div>
        ) : (
          <div className="toolbar">
            <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => setLink((await api<{ url: string }>('/leader-telegram/link', { method: 'POST' })).url))}>
              {t('ltg.connect')}
            </button>
          </div>
        )}

        <div className="rule-card" style={{ marginTop: 14 }}>
          <b style={{ fontSize: 14 }}>{t('ltg.whoTitle')}</b>
          <ul className="rule" style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            <li>{t('ltg.whoDigest', { names: names(v.digestTo) })}</li>
            <li>{t('ltg.whoSignals', { names: names(v.signalsTo) })}</li>
          </ul>
          {(v.legacy.digest.length > 0 || v.legacy.group) && (
            <>
              <b style={{ fontSize: 14, display: 'block', marginTop: 10 }}>{t('ltg.legacyTitle')}</b>
              <ul className="rule" style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {v.legacy.digest.length > 0 && <li>{t('ltg.legacyDigest', { names: v.legacy.digest.map((r) => r.name).join(', ') })}</li>}
                {v.legacy.group && <li>{t('ltg.legacyGroup', { title: v.legacy.group })}</li>}
              </ul>
              <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>{t('ltg.legacyHint')}</p>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
