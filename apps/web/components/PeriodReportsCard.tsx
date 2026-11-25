'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card } from './ui';
import { Switch } from './Switch';

interface Settings {
  weekly: { on: boolean; weekday: number; hour: number; to: string[] };
  monthly: { on: boolean; hour: number; to: string[] };
  serviceBot: boolean;
}

// "Scheduled" → weekly and monthly reports in Telegram: the CLINIC's schedule (owner and manager; one for everybody). Who receives them is each
// person's own choice in their Telegram connection (Settings → General), so saving here never subscribes or unsubscribes anybody. Both start
// off; switching on never sends a report that was due before.
export function PeriodReportsCard() {
  const { t } = useI18n();
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => api<Settings>('/period-reports/settings').then(setS).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    void load();
  }, [load]);
  const patch = async (body: object) => {
    setBusy(true);
    setError('');
    try {
      setS(await api<Settings>('/period-reports/settings', { method: 'PATCH', body: JSON.stringify(body) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!s) return error ? <Alert tone="error">{error}</Alert> : null;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const names = (list: string[]) => (list.length ? list.join(', ') : t('ltg.nobody'));
  const on = s.weekly.on || s.monthly.on;
  return (
    <Card title={t('pr.cardTitle')} actions={<Badge tone={on ? 'green' : 'gray'}>{on ? t('dg.on') : t('dg.off')}</Badge>}>
      {error && <Alert tone="error">{error}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('pr.cardIntro')}</p>
      {!s.serviceBot && <Alert tone="info">{t('ltg.offText')}</Alert>}

      <Switch checked={s.weekly.on} disabled={busy} onChange={(v) => void patch({ weeklyOn: v })} label={t('pr.weekly')} hint={t('pr.weeklyHint')} />
      {s.weekly.on && (
        <div className="toolbar" style={{ alignItems: 'flex-end', marginBottom: 8 }}>
          <label className="field" style={{ margin: 0 }}>
            <span>{t('dg.weekday')}</span>
            <select className="select" value={s.weekly.weekday} disabled={busy} onChange={(e) => void patch({ weeklyWeekday: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{t(`dg.wd${n}` as never)}</option>)}
            </select>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>{t('dg.hour')}</span>
            <select className="select" value={s.weekly.hour} disabled={busy} onChange={(e) => void patch({ weeklyHour: Number(e.target.value) })}>
              {hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </label>
        </div>
      )}
      <Switch checked={s.monthly.on} disabled={busy} onChange={(v) => void patch({ monthlyOn: v })} label={t('pr.monthly')} hint={t('pr.monthlyHint')} />
      {s.monthly.on && (
        <div className="toolbar" style={{ alignItems: 'flex-end', marginBottom: 8 }}>
          <label className="field" style={{ margin: 0 }}>
            <span>{t('dg.hour')}</span>
            <select className="select" value={s.monthly.hour} disabled={busy} onChange={(e) => void patch({ monthlyHour: Number(e.target.value) })}>
              {hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </label>
        </div>
      )}

      <div className="rule-card" style={{ marginTop: 10 }}>
        <b style={{ fontSize: 14 }}>{t('ltg.whoTitle')}</b>
        <ul className="rule" style={{ margin: '6px 0 0', paddingLeft: 20 }}>
          <li>{t('pr.whoWeekly', { names: names(s.weekly.to) })}</li>
          <li>{t('pr.whoMonthly', { names: names(s.monthly.to) })}</li>
        </ul>
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>{t('pr.whoHint')}</p>
      </div>
      <div className="toolbar" style={{ marginTop: 10 }}>
        <Link className="btn btn-sm btn-primary" href="/period-report">{t('pr.openPreview')}</Link>
        <Link className="btn btn-sm" href="/settings#leader-telegram">{t('dg.mySettings')}</Link>
      </div>
    </Card>
  );
}
