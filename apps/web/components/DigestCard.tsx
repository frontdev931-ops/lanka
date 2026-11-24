'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card } from './ui';
import { ProHint } from './ProHint';
import { useConfirm } from './ConfirmDialog';

interface Digest {
  frequency: 'OFF' | 'DAILY' | 'WEEKLY';
  hour: number;
  weekday: number;
  recipients: { id: string; name: string; lang: string }[];
  botConnected: boolean;
  serviceBot: boolean;
}
// who receives it through the LANKA service bot (GET /leader-telegram)
interface Leaders { digestTo: string[]; me: { digest: boolean } | null; available: boolean }

// The manager's digest in Telegram: frequency and time. It goes through the LANKA service bot to each manager who connected their own Telegram
// (Settings → General) and switched the digest on; legacy chats of the clinic's patient bot keep receiving it until the person reconnects.
export function DigestCard() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [d, setD] = useState<Digest | null>(null);
  const [leaders, setLeaders] = useState<Leaders | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = useCallback(() => {
    api<Leaders>('/leader-telegram').then(setLeaders).catch(() => undefined);
    return api<Digest>('/digest').then(setD).catch((e) => setError((e as Error).message));
  }, []);
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

  const people = leaders?.digestTo ?? [];
  const total = people.length + d.recipients.length;
  return (
    <Card title={t('dg.title')} actions={<Badge tone={d.frequency === 'OFF' || !total ? 'gray' : 'green'}>{d.frequency === 'OFF' ? t('dg.off') : !total ? t('dg.noRecipients') : t('dg.on')}</Badge>}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      <ProHint feature="daily_digest" />
      {info && <Alert tone="success">{info}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('dg.intro')}</p>

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
      <p className="rule" style={{ marginTop: 0 }}>{t('dg.viaLanka', { names: people.length ? people.join(', ') : t('ltg.nobody') })}</p>
      {d.recipients.length > 0 && (
        <>
          <p className="rule" style={{ margin: '0 0 6px' }}>{t('dg.legacy')}</p>
          {d.recipients.map((r) => (
            <div key={r.id} className="toolbar" style={{ marginBottom: 6 }}>
              <span className="grow"><b>{r.name}</b> <Badge tone="amber">{t('dg.legacyBadge')}</Badge></span>
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={async () => (await ask(t('dg.removeConfirm', { name: r.name }), { danger: true, confirmLabel: t('common.delete') })) && run(async () => { await api(`/digest/recipients/${r.id}`, { method: 'DELETE' }); await load(); })}
              >
                {t('common.delete')}
              </button>
            </div>
          ))}
        </>
      )}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <a className="btn btn-sm btn-primary" href="/settings#leader-telegram">{leaders?.me ? t('dg.mySettings') : t('ltg.connect')}</a>
        {total > 0 && (
          <button className="btn btn-sm" disabled={busy} onClick={() => run(async () => { const r = await api<{ sent: number }>('/digest/test', { method: 'POST' }); if (!r.sent) throw new Error(t('dg.testFail')); }, t('dg.testOk'))}>
            {t('dg.test')}
          </button>
        )}
      </div>
    </Card>
  );
}
