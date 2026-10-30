'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card } from './ui';
import { QrCode } from './QrCode';
import { useConfirm } from './ConfirmDialog';

interface Digest {
  frequency: 'OFF' | 'DAILY' | 'WEEKLY';
  hour: number;
  weekday: number;
  recipients: { id: string; name: string; lang: string }[];
  botConnected: boolean;
}

// Дайджест руководителю в Telegram: частота и время, получатели привязываются ссылкой (по номеру телефона Telegram не позволяет)
export function DigestCard() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [d, setD] = useState<Digest | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = useCallback(() => api<Digest>('/digest').then(setD).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!info) return;
    const id = setTimeout(() => setInfo(''), 6000);
    return () => clearTimeout(id);
  }, [info]);

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      if (ok) setInfo(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const patch = (body: object) => run(async () => setD(await api<Digest>('/digest', { method: 'PATCH', body: JSON.stringify(body) })), t('common.saved'));

  if (!d) return error ? <Alert tone="error">{error}</Alert> : null;
  const days = [1, 2, 3, 4, 5, 6, 7];

  return (
    <Card title={t('dg.title')} actions={<Badge tone={d.frequency === 'OFF' || !d.recipients.length ? 'gray' : 'green'}>{d.frequency === 'OFF' ? t('dg.off') : !d.recipients.length ? t('dg.noRecipients') : t('dg.on')}</Badge>}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('dg.intro')}</p>
      {!d.botConnected && <Alert tone="warn">{t('dg.needBot')}</Alert>}

      <div className="toolbar" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ margin: 0 }}>
          <span>{t('dg.freq')}</span>
          <select className="select" value={d.frequency} disabled={busy} onChange={(e) => patch({ frequency: e.target.value })}>
            <option value="OFF">{t('dg.freqOff')}</option>
            <option value="WEEKLY">{t('dg.freqWeekly')}</option>
            <option value="DAILY">{t('dg.freqDaily')}</option>
          </select>
        </label>
        {d.frequency === 'WEEKLY' && (
          <label className="field" style={{ margin: 0 }}>
            <span>{t('dg.weekday')}</span>
            <select className="select" value={d.weekday} disabled={busy} onChange={(e) => patch({ weekday: Number(e.target.value) })}>
              {days.map((n) => (
                <option key={n} value={n}>{t(`dg.wd${n}` as never)}</option>
              ))}
            </select>
          </label>
        )}
        {d.frequency !== 'OFF' && (
          <label className="field" style={{ margin: 0 }}>
            <span>{t('dg.hour')}</span>
            <select className="select" value={d.hour} disabled={busy} onChange={(e) => patch({ hour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <h3 style={{ fontSize: 15, margin: '16px 0 6px' }}>{t('dg.recipients')}</h3>
      {d.recipients.length === 0 && <p className="muted" style={{ marginTop: 0 }}>{t('dg.noneYet')}</p>}
      {d.recipients.map((r) => (
        <div key={r.id} className="toolbar" style={{ marginBottom: 6 }}>
          <span className="grow"><b>{r.name}</b></span>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={async () => (await ask(t('dg.removeConfirm', { name: r.name }), { danger: true, confirmLabel: t('common.delete') })) && run(async () => { await api(`/digest/recipients/${r.id}`, { method: 'DELETE' }); await load(); })}
          >
            {t('common.delete')}
          </button>
        </div>
      ))}

      {link ? (
        <div className="toolbar" style={{ alignItems: 'flex-start', gap: 20, marginTop: 8 }}>
          <QrCode value={link} label={t('dg.qr')} />
          <div style={{ minWidth: 0 }}>
            <p className="rule" style={{ marginTop: 0 }}>{t('dg.linkHint')}</p>
            <input className="input" style={{ width: '100%', maxWidth: 420 }} readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={t('dg.qr')} />
            <div className="toolbar" style={{ marginTop: 8 }}>
              <a className="btn btn-sm btn-primary" href={link} target="_blank" rel="noreferrer">{t('dg.openTelegram')}</a>
              <button className="btn btn-sm" onClick={() => { setLink(null); load(); }}>{t('dg.check')}</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="toolbar" style={{ marginTop: 8 }}>
          <button className="btn btn-sm btn-primary" disabled={busy || !d.botConnected || d.recipients.length >= 5} onClick={() => run(async () => setLink((await api<{ url: string }>('/digest/link', { method: 'POST' })).url))}>
            {t('dg.add')}
          </button>
          {d.recipients.length > 0 && (
            <button className="btn btn-sm" disabled={busy} onClick={() => run(async () => { const r = await api<{ sent: number }>('/digest/test', { method: 'POST' }); if (!r.sent) throw new Error(t('dg.testFail')); }, t('dg.testOk'))}>
              {t('dg.test')}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
