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
interface Info {
  configured: boolean;
  source: 'CLINICCARDS' | 'MANUAL' | null;
  updatedAt: string | null;
  holidays: string[];
  connected: boolean;
}

export function WorkHours() {
  const t = useT();
  const [info, setInfo] = useState<Info | null>(null);
  const [week, setWeek] = useState<Week | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Week>('/clinic/work-hours').then(setWeek).catch((e) => setError((e as Error).message));
    api<Info>('/clinic/work-hours/info').then(setInfo).catch(() => undefined);
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
      setInfo(await api<Info>('/clinic/work-hours/info'));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // "Take them from Cliniccards": replaces what was typed by hand, only on this explicit action
  async function importHours() {
    setBusy(true);
    setError('');
    try {
      setInfo(await api<Info>('/clinic/work-hours/import', { method: 'POST' }));
      setWeek(await api<Week>('/clinic/work-hours'));
      setSaved(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

  return (
    <Card title={t('wh.title')}>
      <p className="rule">{t('wh.hint')}</p>
      {info && !info.configured && <Alert tone="warn">{t('wh.notSet')}</Alert>}
      {info?.configured && (
        <p className="muted" style={{ marginTop: 0 }}>
          {info.source === 'CLINICCARDS' ? t('wh.srcCliniccards', { time: when(info.updatedAt) }) : t('wh.srcManual', { time: when(info.updatedAt) })}
          {info.holidays.length > 0 && ` ${t('wh.holidays', { dates: info.holidays.map((d) => d.split('-').reverse().join('.')).join(', ') })}`}
        </p>
      )}
      {info?.connected && (
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <button type="button" className="btn doctor-toolbar-btn" disabled={busy} onClick={importHours}>{t('wh.import')}</button>
        </div>
      )}
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
