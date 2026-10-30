'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { Alert, Card } from './ui';

type Hours = { from: string; to: string } | null;
type Week = Record<string, Hours>;

const DAY_KEYS = [
  ['1', 'wh.d1'],
  ['2', 'wh.d2'],
  ['3', 'wh.d3'],
  ['4', 'wh.d4'],
  ['5', 'wh.d5'],
  ['6', 'wh.d6'],
  ['7', 'wh.d7'],
] as const;

// Рабочие часы клиники по дням недели: по ним считаются свободные окна, когда в Cliniccards нет смен врачей
export function WorkHours() {
  const t = useT();
  const [week, setWeek] = useState<Week | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Week>('/clinic/work-hours').then(setWeek).catch((e) => setError((e as Error).message));
  }, []);

  if (!week) return error ? <Alert tone="error">{error}</Alert> : null;

  function set(day: string, h: Hours) {
    setSaved(false);
    setWeek((w) => ({ ...w!, [day]: h }));
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      setWeek(await api<Week>('/clinic/work-hours', { method: 'PUT', body: JSON.stringify(week) }));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('wh.title')}>
      <p className="rule">{t('wh.hint')}</p>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="hours-list">
        {DAY_KEYS.map(([day, key]) => {
          const h = week[day];
          return (
            <div className="hours-row" key={day}>
              <b className="hours-day">{t(key)}</b>
              <label className="hours-off">
                <input type="checkbox" checked={!h} onChange={(e) => set(day, e.target.checked ? null : { from: '09:00', to: '20:00' })} /> {t('wh.off')}
              </label>
              {h && (
                <span className="hours-times">
                  <input className="input" type="time" value={h.from} onChange={(e) => set(day, { ...h, from: e.target.value })} aria-label={t('wh.from')} />
                  <span>—</span>
                  <input className="input" type="time" value={h.to} onChange={(e) => set(day, { ...h, to: e.target.value })} aria-label={t('wh.to')} />
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="toolbar" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? t('common.wait') : t('common.save')}</button>
        {saved && <span className="muted">{t('common.saved')}</span>}
      </div>
    </Card>
  );
}
