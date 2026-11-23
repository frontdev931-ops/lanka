'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { Key, useI18n } from '../../../../lib/i18n';
import { fmtDateTime } from '../../../../lib/ui';
import { Alert, Badge, Card, Loading, PageHeader } from '../../../../components/ui';
import { Switch } from '../../../../components/Switch';

type Reason = 'PRICE' | 'TIME' | 'SILENT';
type TextKey = Reason | 'AGAIN';
type Status = 'PLANNED' | 'PENDING_APPROVAL' | 'SENDING' | 'SENT' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
interface Item { id: string; channel: string; chatId: string; name: string | null; reason: Reason; step: number; text: string; dueAt: string; expiresAt: string | null; status: Status; sentAt: string | null; error: string | null }
interface Settings { enabled: boolean; days: number; texts: Record<TextKey, { uk: string; ru: string }>; sendingEnabled: boolean }
interface View { settings: Settings; items: Item[] }

const TONE: Record<Status, 'gray' | 'amber' | 'green' | 'red' | 'blue'> = { PLANNED: 'blue', PENDING_APPROVAL: 'amber', SENDING: 'blue', SENT: 'green', CANCELLED: 'gray', EXPIRED: 'gray', FAILED: 'red' };
const KEYS: TextKey[] = ['PRICE', 'TIME', 'SILENT', 'AGAIN'];
// the reasons a follow-up was not sent, as the server records them
const WHY = ['patient_wrote', 'expired', 'window_closed', 'switched_off', 'by_staff', 'booked', 'request_open', 'dialogue_changed', 'opted_out'];
const CH: Record<string, string> = { INSTAGRAM: 'Instagram', MESSENGER: 'Messenger', TELEGRAM: 'Telegram' };

// "AI administrator" → "Follow-ups": the agent's dialogues that stopped before a booking (the price was asked, the offered time did not suit, no answer) and the
// messages that bring them back: one the next day inside Instagram's/Messenger's 24-hour window, in Telegram also a second one later. The owner and the
// manager switch it on and edit the texts; the administrator sends the waiting ones. Sending follows the master switch; without the agent's own replies a
// staff member sends each one.
export default function FollowUpsPage() {
  const { t } = useI18n();
  const [v, setV] = useState<View | null>(null);
  const [role, setRole] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [days, setDays] = useState('3');
  const [texts, setTexts] = useState<Settings['texts'] | null>(null);
  const [saved, setSaved] = useState('');
  const load = useCallback(() => api<View>('/follow-ups').then((r) => { setV(r); setDays(String(r.settings.days)); setTexts(r.settings.texts); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    void load();
    api<{ role: string }>('/auth/me').then((m) => setRole(m.role)).catch(() => undefined);
  }, [load]);
  const lead = role === 'OWNER' || role === 'MANAGER';

  async function save(body: Record<string, unknown>) {
    setBusy('settings');
    setError('');
    setSaved('');
    try {
      await api('/follow-ups/settings', { method: 'PATCH', body: JSON.stringify(body) });
      await load();
      setSaved(t('fu.saved'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function act(id: string, what: 'send' | 'cancel') {
    setBusy(id);
    setError('');
    try {
      await api(`/follow-ups/${id}/${what}`, { method: 'POST' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await load();
      setBusy(null);
    }
  }

  const header = <PageHeader title={t('fu.title')} subtitle={t('fu.subtitle')} />;
  if (!v) return <>{header}{error ? <Alert tone="error">{error}</Alert> : <Loading />}</>;
  const s = v.settings;
  const waiting = v.items.filter((i) => i.status === 'PENDING_APPROVAL');
  const planned = v.items.filter((i) => i.status === 'PLANNED');
  const done = v.items.filter((i) => !['PENDING_APPROVAL', 'PLANNED'].includes(i.status));
  const textsDirty = !!texts && KEYS.some((k) => texts[k].uk !== s.texts[k].uk || texts[k].ru !== s.texts[k].ru);

  const row = (i: Item) => (
    <tr key={i.id}>
      <td>
        <b>{i.name ?? t('fu.noName')}</b>
        <div className="muted" style={{ fontSize: 13 }}>{CH[i.channel] ?? i.channel}</div>
      </td>
      <td><Badge tone={i.reason === 'PRICE' ? 'amber' : i.reason === 'TIME' ? 'blue' : 'gray'}>{t(`fu.reason.${i.reason}` as Key)}</Badge>{i.step > 1 && <div className="muted" style={{ fontSize: 13 }}>{t('fu.second')}</div>}</td>
      <td style={{ maxWidth: 360 }}><span style={{ fontSize: 14 }}>{i.text}</span></td>
      <td>
        <Badge tone={TONE[i.status]}>{t(`fu.status.${i.status}` as Key)}</Badge>
        <div className="muted" style={{ fontSize: 13 }}>{i.sentAt ? fmtDateTime(i.sentAt) : fmtDateTime(i.dueAt)}</div>
        {i.error && i.status !== 'SENT' && WHY.includes(i.error) && <div className="muted" style={{ fontSize: 13 }}>{t(`fu.why.${i.error}` as Key)}</div>}
      </td>
      <td>
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          {(i.status === 'PENDING_APPROVAL' || i.status === 'PLANNED') && (
            <>
              <button className="btn btn-sm btn-primary" disabled={!!busy || !s.sendingEnabled} onClick={() => void act(i.id, 'send')}>{t('fu.sendNow')}</button>
              <button className="btn btn-sm" disabled={!!busy} onClick={() => void act(i.id, 'cancel')}>{t('fu.cancel')}</button>
            </>
          )}
          <Link className="btn btn-sm" href={`/inbox?channel=${encodeURIComponent(i.channel)}&chat=${encodeURIComponent(i.chatId)}`}>{t('fu.openChat')}</Link>
        </div>
      </td>
    </tr>
  );
  const table = (items: Item[]) => (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>{t('fu.col.who')}</th><th>{t('fu.col.reason')}</th><th>{t('fu.col.text')}</th><th>{t('fu.col.status')}</th><th>{t('fu.col.actions')}</th></tr></thead>
        <tbody>{items.map(row)}</tbody>
      </table>
    </div>
  );

  return (
    <>
      {header}
      {error && <Alert tone="error">{error}</Alert>}
      {s.enabled && !s.sendingEnabled && <Alert tone="warn">{t('fu.sendingOff')} <Link href="/automations">{t('fu.sendingLink')}</Link></Alert>}

      <Card title={t('fu.settings')}>
        <Switch checked={s.enabled} disabled={!lead || busy === 'settings'} label={t('fu.enable')} hint={t('fu.enableHint')} onChange={(on) => void save({ enabled: on })} />
        <p className="rule">{t('fu.rules')}</p>
        <label className="field" style={{ maxWidth: 360 }}>
          <span>{t('fu.days')}</span>
          <div className="toolbar">
            <input className="input" type="number" inputMode="numeric" min={1} max={14} value={days} disabled={!lead} onChange={(e) => setDays(e.target.value)} style={{ width: 90 }} />
            {lead && days !== String(s.days) && <button className="btn btn-sm btn-primary" disabled={busy === 'settings'} onClick={() => void save({ days: Number(days) })}>{t('common.save')}</button>}
          </div>
        </label>
        {lead && texts && (
          <details className="more-details">
            <summary>{t('fu.texts')}</summary>
            {KEYS.map((k) => (
              <div key={k} style={{ marginBottom: 12 }}>
                <b style={{ fontSize: 14 }}>{t(`fu.text.${k}` as Key)}</b>
                {(['uk', 'ru'] as const).map((l) => (
                  <label key={l} className="field">
                    <span className="muted" style={{ fontSize: 13 }}>{l === 'uk' ? t('fu.lang.uk') : t('fu.lang.ru')}</span>
                    <textarea className="input" rows={3} maxLength={500} value={texts[k][l]} onChange={(e) => setTexts({ ...texts, [k]: { ...texts[k], [l]: e.target.value } })} />
                  </label>
                ))}
              </div>
            ))}
            {textsDirty && <button className="btn btn-primary" disabled={busy === 'settings'} onClick={() => void save({ texts })}>{t('common.save')}</button>}
          </details>
        )}
        {saved && <p className="muted" role="status" style={{ fontSize: 13 }}>{saved}</p>}
      </Card>

      <Card title={`${t('fu.waiting')} · ${waiting.length}`}>
        {waiting.length ? table(waiting) : <p className="muted">{t('fu.waitingNone')}</p>}
        {waiting.length > 0 && <p className="muted" style={{ fontSize: 13 }}>{t('fu.waitingHint')}</p>}
      </Card>
      {planned.length > 0 && <Card title={`${t('fu.planned')} · ${planned.length}`}>{table(planned)}</Card>}
      {done.length > 0 && <Card title={t('fu.history')}>{table(done.slice(0, 50))}</Card>}
    </>
  );
}
