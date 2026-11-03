'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { Alert, Badge, Card } from './ui';

interface DoctorRow {
  externalId: string;
  name: string;
  active: boolean;
  serviceIds: string[];
  acceptsUrgent: boolean;
  scheduleSource: 'SHIFTS' | 'LANKA' | 'NONE';
  problems: string[];
}
interface Overview {
  connected: boolean;
  refreshFailed: boolean;
  primary: { doctorId: string; name: string | null; problems: string[] } | null;
  doctors: DoctorRow[];
  services: { id: string; title: string; durationMin: number | null; approved: boolean }[];
  cabinets: { externalId: string; name: string }[];
}
interface Weekly {
  weekday: number;
  from: string;
  to: string;
  cabinetId: string;
}
interface Exc {
  date: string;
  closed: boolean;
  from?: string;
  to?: string;
}
interface Avail {
  weekly: Weekly[];
  exceptions: Exc[];
  source: 'SHIFTS' | 'LANKA' | 'NONE';
  warnings?: { weekday: number; cabinetId: string; visits: number }[];
}

const DAYS = ['wh.d1', 'wh.d2', 'wh.d3', 'wh.d4', 'wh.d5', 'wh.d6', 'wh.d7'] as const;
const PROBLEM = { inactive: 'dr.p.inactive', no_services: 'dr.p.no_services', no_schedule: 'dr.p.no_schedule', missing: 'dr.p.missing' } as const;

// The doctor for a first booking, what each doctor provides and the schedule of online booking kept in LANKA. Every doctor comes from
// Cliniccards and is saved by his id there. A problem is written next to the doctor, so it is clear why the bot cannot book him by itself.
export function DoctorSettings() {
  const t = useT();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback((refresh: boolean) => {
    setBusy(true);
    return api<Overview>(refresh ? '/doctors/refresh' : '/doctors', refresh ? { method: 'POST' } : undefined)
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => { load(false); }, [load]);

  async function setPrimary(id: string) {
    setBusy(true);
    try {
      setData(await api<Overview>('/doctors/primary', { method: 'PUT', body: JSON.stringify({ doctorId: id || null }) }));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return error ? <Alert tone="error">{error}</Alert> : null;
  const active = data.doctors.filter((d) => d.active);
  const problemText = (p: string[], prefix: boolean) => p.map((x) => t(PROBLEM[x as keyof typeof PROBLEM] ?? 'dr.p.no_schedule')).join('; ') || (prefix ? '' : '');

  return (
    <Card title={t('dr.title')}>
      <p className="rule">{t('dr.hint')}</p>
      {error && <Alert tone="error">{error}</Alert>}
      {!data.connected && <Alert tone="warn">{t('dr.notConnected')}</Alert>}
      {data.refreshFailed && data.connected && <Alert tone="warn">{t('dr.refreshFailed')}</Alert>}
      <label className="field">
        <span>{t('dr.primary')}</span>
        <select className="select" value={data.primary?.doctorId ?? ''} disabled={busy} onChange={(e) => setPrimary(e.target.value)}>
          <option value="">{t('dr.primaryNone')}</option>
          {active.map((d) => <option key={d.externalId} value={d.externalId}>{d.name}</option>)}
          {data.primary && !active.some((d) => d.externalId === data.primary!.doctorId) && <option value={data.primary.doctorId}>{data.primary.name ?? data.primary.doctorId}</option>}
        </select>
      </label>
      <p className="muted" style={{ marginTop: 0 }}>{t('dr.primaryHint')}</p>
      {data.primary && data.primary.problems.length > 0 && <Alert tone="warn">{t('dr.primaryProblems', { text: problemText(data.primary.problems, true) })}</Alert>}
      <div className="toolbar" style={{ margin: '8px 0 14px' }}>
        <button className="btn" disabled={busy} onClick={() => load(true)}>{t('dr.refresh')}</button>
      </div>
      {active.length === 0 && <p className="muted">{t('dr.none')}</p>}
      {data.doctors.map((d) => <DoctorCard key={d.externalId} d={d} data={data} onChanged={setData} />)}
    </Card>
  );
}

function DoctorCard({ d, data, onChanged }: { d: DoctorRow; data: Overview; onChanged: (o: Overview) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [avail, setAvail] = useState<Avail | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && !avail) api<Avail>(`/doctors/${d.externalId}/availability`).then(setAvail).catch((e) => setError((e as Error).message));
  }, [open, avail, d.externalId]);

  async function profile(patch: { serviceIds?: string[]; acceptsUrgent?: boolean }) {
    setBusy(true);
    try {
      onChanged(await api<Overview>(`/doctors/${d.externalId}/profile`, { method: 'PUT', body: JSON.stringify(patch) }));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveAvail() {
    if (!avail) return;
    setBusy(true);
    setError('');
    try {
      setAvail(await api<Avail>(`/doctors/${d.externalId}/availability`, { method: 'PUT', body: JSON.stringify({ weekly: avail.weekly, exceptions: avail.exceptions }) }));
      setSaved(true);
      onChanged(await api<Overview>('/doctors'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const edit = (patch: Partial<Avail>) => { setSaved(false); setAvail({ ...avail!, ...patch }); };

  return (
    <div className="doctor-card">
      <button type="button" className="doctor-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <b>{d.name}</b>
        {!d.active && <Badge tone="gray">{t('dr.p.inactive')}</Badge>}
        {d.active && d.problems.filter((p) => p !== 'inactive').map((p) => <Badge key={p} tone="amber">{t(PROBLEM[p as keyof typeof PROBLEM] ?? 'dr.p.no_schedule')}</Badge>)}
        {d.active && d.problems.length === 0 && <Badge tone="green">{t('dr.ready')}</Badge>}
      </button>
      {open && !d.active && <div className="doctor-body"><p className="muted">{t('dr.inactiveNote')}</p></div>}
      {open && d.active && (
        <div className="doctor-body">
          {error && <Alert tone="error">{error}</Alert>}
          <b>{t('dr.services')}</b>
          <p className="muted" style={{ margin: '2px 0 6px' }}>{t('dr.servicesHint')}</p>
          {data.services.length === 0 && <p className="muted">{t('dr.noServices')}</p>}
          <div className="doctor-services">
            {data.services.map((s) => (
              <label key={s.id} className="check-row" style={{ margin: 0 }}>
                <input type="checkbox" disabled={busy} checked={d.serviceIds.includes(s.id)} onChange={(e) => profile({ serviceIds: e.target.checked ? [...d.serviceIds, s.id] : d.serviceIds.filter((x) => x !== s.id) })} />
                <span>{s.title}{s.durationMin ? ` · ${s.durationMin} ${t('book.min')}` : ''}</span>
              </label>
            ))}
          </div>
          <label className="check-row">
            <input type="checkbox" disabled={busy} checked={d.acceptsUrgent} onChange={(e) => profile({ acceptsUrgent: e.target.checked })} />
            <span><b>{t('dr.urgent')}</b><br /><span className="muted">{t('dr.urgentHint')}</span></span>
          </label>

          <b>{t('dr.schedule')}</b>
          <p className="muted" style={{ margin: '2px 0 6px' }}>{avail?.source === 'SHIFTS' ? t('dr.src.SHIFTS') : avail?.source === 'LANKA' ? t('dr.src.LANKA') : t('dr.src.NONE')}</p>
          {avail?.source === 'SHIFTS' && <Alert tone="info">{t('dr.shiftsNote')}</Alert>}
          {avail && (
            <>
              <p className="rule" style={{ marginTop: 0 }}>{t('dr.scheduleHint')}</p>
              {avail.weekly.map((w, i) => (
                <div className="doctor-row" key={i}>
                  <select className="select" aria-label={t('dr.day')} value={w.weekday} onChange={(e) => edit({ weekly: avail.weekly.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)) })}>
                    {DAYS.map((k, n) => <option key={k} value={n + 1}>{t(k)}</option>)}
                  </select>
                  <input className="input" type="time" aria-label={t('wh.from')} value={w.from} onChange={(e) => edit({ weekly: avail.weekly.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} />
                  <input className="input" type="time" aria-label={t('wh.to')} value={w.to} onChange={(e) => edit({ weekly: avail.weekly.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })} />
                  <select className="select" aria-label={t('book.cabinet')} value={w.cabinetId} onChange={(e) => edit({ weekly: avail.weekly.map((x, j) => (j === i ? { ...x, cabinetId: e.target.value } : x)) })}>
                    {data.cabinets.map((c) => <option key={c.externalId} value={c.externalId}>{c.name}</option>)}
                  </select>
                  <button type="button" className="btn btn-sm" onClick={() => edit({ weekly: avail.weekly.filter((_, j) => j !== i) })}>{t('dr.remove')}</button>
                </div>
              ))}
              <div className="toolbar" style={{ margin: '6px 0 12px' }}>
                <button type="button" className="btn btn-sm" disabled={!data.cabinets.length} onClick={() => edit({ weekly: [...avail.weekly, { weekday: 1, from: '09:00', to: '18:00', cabinetId: data.cabinets[0]?.externalId ?? '' }] })}>{t('dr.addRow')}</button>
              </div>
              <b>{t('dr.exceptions')}</b>
              {avail.exceptions.map((x, i) => (
                <div className="doctor-row" key={i}>
                  <input className="input" type="date" aria-label={t('book.date')} value={x.date} onChange={(e) => edit({ exceptions: avail.exceptions.map((y, j) => (j === i ? { ...y, date: e.target.value } : y)) })} />
                  <label className="hours-off"><input type="checkbox" checked={x.closed} onChange={(e) => edit({ exceptions: avail.exceptions.map((y, j) => (j === i ? { ...y, closed: e.target.checked, ...(e.target.checked ? { from: undefined, to: undefined } : { from: '10:00', to: '14:00' }) } : y)) })} /> {t('dr.closed')}</label>
                  {!x.closed && <input className="input" type="time" aria-label={t('wh.from')} value={x.from ?? ''} onChange={(e) => edit({ exceptions: avail.exceptions.map((y, j) => (j === i ? { ...y, from: e.target.value } : y)) })} />}
                  {!x.closed && <input className="input" type="time" aria-label={t('wh.to')} value={x.to ?? ''} onChange={(e) => edit({ exceptions: avail.exceptions.map((y, j) => (j === i ? { ...y, to: e.target.value } : y)) })} />}
                  <button type="button" className="btn btn-sm" onClick={() => edit({ exceptions: avail.exceptions.filter((_, j) => j !== i) })}>{t('dr.remove')}</button>
                </div>
              ))}
              <div className="toolbar" style={{ margin: '6px 0 12px' }}>
                <button type="button" className="btn btn-sm" onClick={() => edit({ exceptions: [...avail.exceptions, { date: '', closed: true }] })}>{t('dr.addException')}</button>
              </div>
              {avail.warnings && avail.warnings.length > 0 && <Alert tone="warn">{t('dr.warnBusy', { n: avail.warnings.reduce((s, w) => s + w.visits, 0) })}</Alert>}
              <div className="toolbar">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={saveAvail}>{busy ? t('common.wait') : t('common.save')}</button>
                {saved && <span className="muted">{t('common.saved')}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
