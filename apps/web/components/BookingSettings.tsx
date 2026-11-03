'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { Alert, Badge, Card } from './ui';
import { DoctorSettings } from './DoctorSettings';

interface Cab {
  externalId: string;
  name: string;
  onlineBooking: boolean;
  acceptsUrgent: boolean;
}
interface Svc {
  id: string;
  title: string;
  durationMin: number | null;
  approved: boolean;
  onlineBooking: boolean;
  cabinetIds: string[];
}
interface Exc {
  date: string;
  closed: boolean;
  from?: string;
  to?: string;
}
interface Settings {
  mode: 'DOCTORS' | 'CABINETS';
  shared: { doctorId: string; name: string | null; missing: boolean } | null;
  accounts: { externalId: string; name: string }[];
  cabinets: Cab[];
  services: Svc[];
  exceptions: Exc[];
  hoursSet: boolean;
  problems: string[];
}

const PROBLEM = { no_shared_account: 'cb.p.no_shared_account', no_cabinets: 'cb.p.no_cabinets', no_services: 'cb.p.no_services', no_hours: 'cb.p.no_hours' } as const;

// How the schedule is organised: by doctors, or by cabinets through one shared account of Cliniccards. A separate choice from the way a
// request is handled (a request for an administrator or the automatic booking): both ways work with both.
export function BookingSettings() {
  const t = useT();
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<Settings>('/booking-settings').then((d) => { setS(d); setError(''); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);

  async function call(path: string, body: unknown) {
    setBusy(true);
    try {
      setS(await api<Settings>(`/booking-settings/${path}`, { method: 'PUT', body: JSON.stringify(body) }));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!s) return error ? <Alert tone="error">{error}</Alert> : null;
  return (
    <>
      <Card title={t('cb.modeTitle')}>
        {error && <Alert tone="error">{error}</Alert>}
        <p className="rule">{t('cb.modeHint')}</p>
        <label className="check-row" style={{ margin: '6px 0' }}>
          <input type="radio" name="schedule-mode" checked={s.mode === 'DOCTORS'} disabled={busy} onChange={() => call('mode', { mode: 'DOCTORS' })} />
          <span><b>{t('cb.byDoctors')}</b><br /><span className="muted">{t('cb.byDoctorsHint')}</span></span>
        </label>
        <label className="check-row" style={{ margin: '6px 0' }}>
          <input type="radio" name="schedule-mode" checked={s.mode === 'CABINETS'} disabled={busy} onChange={() => call('mode', { mode: 'CABINETS' })} />
          <span><b>{t('cb.byCabinets')}</b><br /><span className="muted">{t('cb.byCabinetsHint')}</span></span>
        </label>
      </Card>
      {s.mode === 'DOCTORS' ? <DoctorSettings /> : <CabinetSettings s={s} busy={busy} call={call} />}
    </>
  );
}

function CabinetSettings({ s, busy, call }: { s: Settings; busy: boolean; call: (path: string, body: unknown) => Promise<void> }) {
  const t = useT();
  const [exc, setExc] = useState<Exc[]>(s.exceptions);
  const [saved, setSaved] = useState(false);
  useEffect(() => setExc(s.exceptions), [s.exceptions]);

  const cabs = (patch: (c: Cab) => Cab) => call('cabinets', { cabinets: s.cabinets.map((c) => { const x = patch(c); return { externalId: x.externalId, onlineBooking: x.onlineBooking, acceptsUrgent: x.acceptsUrgent }; }) });
  const svc = (id: string, patch: Partial<Svc>) => call('services', { services: [{ id, onlineBooking: patch.onlineBooking ?? s.services.find((x) => x.id === id)!.onlineBooking, cabinetIds: patch.cabinetIds ?? s.services.find((x) => x.id === id)!.cabinetIds }] });
  const setE = (list: Exc[]) => { setSaved(false); setExc(list); };

  return (
    <Card title={t('cb.title')}>
      <p className="rule">{t('cb.hint')}</p>
      {s.problems.length > 0 ? (
        <Alert tone="warn">
          <b>{t('cb.missing')}</b>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{s.problems.map((p) => <li key={p}>{t(PROBLEM[p as keyof typeof PROBLEM] ?? 'cb.p.no_hours')}</li>)}</ul>
        </Alert>
      ) : (
        <Alert tone="success">{t('cb.ready')}</Alert>
      )}

      <b>{t('cb.shared')}</b>
      <label className="field" style={{ marginTop: 6 }}>
        <select className="select" value={s.shared?.doctorId ?? ''} disabled={busy} onChange={(e) => call('shared-account', { doctorId: e.target.value || null })}>
          <option value="">{t('cb.sharedNone')}</option>
          {s.accounts.map((a) => <option key={a.externalId} value={a.externalId}>{a.name}</option>)}
        </select>
      </label>
      <p className="muted" style={{ marginTop: 0 }}>{t('cb.sharedHint')}</p>
      {s.shared?.missing && <Alert tone="warn">{t('cb.sharedMissing')}</Alert>}

      <b>{t('cb.cabinets')}</b>
      <p className="muted" style={{ margin: '2px 0 6px' }}>{t('cb.cabinetsHint')}</p>
      {s.cabinets.length === 0 && <p className="muted">{t('cb.noCabinets')}</p>}
      {s.cabinets.map((c) => (
        <div className="doctor-card" key={c.externalId}>
          <div className="doctor-body" style={{ borderTop: 'none' }}>
            <b>{c.name}</b>
            <label className="check-row" style={{ margin: '4px 0' }}>
              <input type="checkbox" disabled={busy} checked={c.onlineBooking} onChange={(e) => cabs((x) => (x.externalId === c.externalId ? { ...x, onlineBooking: e.target.checked } : x))} />
              <span>{t('cb.online')}</span>
            </label>
            <label className="check-row" style={{ margin: '4px 0' }}>
              <input type="checkbox" disabled={busy || !c.onlineBooking} checked={c.acceptsUrgent} onChange={(e) => cabs((x) => (x.externalId === c.externalId ? { ...x, acceptsUrgent: e.target.checked } : x))} />
              <span>{t('cb.urgent')}</span>
            </label>
          </div>
        </div>
      ))}

      <b>{t('cb.services')}</b>
      <p className="muted" style={{ margin: '2px 0 6px' }}>{t('cb.servicesHint')}</p>
      {s.services.length === 0 && <p className="muted">{t('dr.noServices')}</p>}
      {s.services.map((v) => {
        const ok = !!v.durationMin && v.approved;
        return (
          <div className="doctor-card" key={v.id}>
            <div className="doctor-body" style={{ borderTop: 'none' }}>
              <label className="check-row" style={{ margin: '4px 0' }}>
                <input type="checkbox" disabled={busy || (!ok && !v.onlineBooking)} checked={v.onlineBooking} onChange={(e) => svc(v.id, { onlineBooking: e.target.checked })} />
                <span><b>{v.title}</b>{v.durationMin ? ` · ${v.durationMin} ${t('book.min')}` : ''}{!ok && <> <Badge tone="amber">{v.durationMin ? t('cb.notApproved') : t('cb.noLength')}</Badge></>}</span>
              </label>
              {v.onlineBooking && s.cabinets.length > 1 && (
                <div>
                  <span className="muted">{t('cb.serviceCabinets')}</span>
                  {s.cabinets.filter((c) => c.onlineBooking).map((c) => (
                    <label key={c.externalId} className="check-row" style={{ margin: '2px 0' }}>
                      <input type="checkbox" disabled={busy} checked={v.cabinetIds.includes(c.externalId)} onChange={(e) => svc(v.id, { cabinetIds: e.target.checked ? [...v.cabinetIds, c.externalId] : v.cabinetIds.filter((x) => x !== c.externalId) })} />
                      <span>{c.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}

      <b>{t('cb.hours')}</b>
      <p className="muted" style={{ margin: '2px 0 6px' }}>{s.hoursSet ? t('cb.hoursHint') : t('cb.hoursUnset')}</p>
      {exc.map((x, i) => (
        <div className="doctor-row" key={i}>
          <input className="input" type="date" aria-label={t('book.date')} value={x.date} onChange={(e) => setE(exc.map((y, j) => (j === i ? { ...y, date: e.target.value } : y)))} />
          <label className="hours-off"><input type="checkbox" checked={x.closed} onChange={(e) => setE(exc.map((y, j) => (j === i ? { ...y, closed: e.target.checked, ...(e.target.checked ? { from: undefined, to: undefined } : { from: '10:00', to: '14:00' }) } : y)))} /> {t('dr.closed')}</label>
          {!x.closed && <input className="input" type="time" aria-label={t('wh.from')} value={x.from ?? ''} onChange={(e) => setE(exc.map((y, j) => (j === i ? { ...y, from: e.target.value } : y)))} />}
          {!x.closed && <input className="input" type="time" aria-label={t('wh.to')} value={x.to ?? ''} onChange={(e) => setE(exc.map((y, j) => (j === i ? { ...y, to: e.target.value } : y)))} />}
          <button type="button" className="btn btn-sm" onClick={() => setE(exc.filter((_, j) => j !== i))}>{t('dr.remove')}</button>
        </div>
      ))}
      <div className="toolbar doctor-toolbar" style={{ margin: '6px 0 12px' }}>
        <button type="button" className="btn btn-sm" onClick={() => setE([...exc, { date: '', closed: true }])}>{t('dr.addException')}</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { await call('exceptions', { exceptions: exc }); setSaved(true); }}>{t('common.save')}</button>
        {saved && <span className="muted">{t('common.saved')}</span>}
      </div>
    </Card>
  );
}
