'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert } from './ui';

interface Options {
  cabinets: { externalId: string; name: string }[];
  doctors: { externalId: string; name: string }[];
}

// Books a visit in the clinic's system for a request. The administrator picks the time; the server re-checks the place against
// fresh data and never writes the same visit twice. Shown only when the service owner has enabled writing for the clinic.
export function BookingForm({ patientId, requestId, onDone }: { patientId: string; requestId: string; onDone: () => void }) {
  const { t } = useI18n();
  const [opts, setOpts] = useState<Options | null>(null);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('10:00');
  const [duration, setDuration] = useState(30);
  const [cabinet, setCabinet] = useState('');
  const [doctor, setDoctor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<Options>('/bookings/options').then((o) => {
      setOpts(o);
      setCabinet(o.cabinets[0]?.externalId ?? '');
    }).catch((e) => setError((e as Error).message));
  }, []);

  async function save() {
    setBusy(true);
    setError('');
    try {
      // the field values are the clinic's local time; the browser converts them to one moment using its own zone, which is the clinic's
      await api('/bookings', { method: 'POST', body: JSON.stringify({ patientId, requestId, startsAt: new Date(`${date}T${time}:00`).toISOString(), durationMin: duration, cabinetId: cabinet, ...(doctor ? { doctorId: doctor } : {}) }) });
      setDone(true);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Alert tone="success">{t('book.done')}</Alert>;
  return (
    <div className="chat-link">
      {error && <Alert tone="error">{error}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('book.hint')}</p>
      <div className="toolbar">
        <label className="field" style={{ margin: 0 }}><span>{t('book.date')}</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field" style={{ margin: 0 }}><span>{t('book.time')}</span><input className="input" type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} /></label>
        <label className="field" style={{ margin: 0 }}>
          <span>{t('book.duration')}</span>
          <select className="select" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {[30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} {t('book.min')}</option>)}
          </select>
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>{t('book.cabinet')}</span>
          <select className="select" value={cabinet} onChange={(e) => setCabinet(e.target.value)}>
            {opts?.cabinets.map((c) => <option key={c.externalId} value={c.externalId}>{c.name}</option>)}
          </select>
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>{t('book.doctor')}</span>
          <select className="select" value={doctor} onChange={(e) => setDoctor(e.target.value)}>
            <option value="">{t('book.anyDoctor')}</option>
            {opts?.doctors.map((d) => <option key={d.externalId} value={d.externalId}>{d.name}</option>)}
          </select>
        </label>
      </div>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="btn btn-primary" disabled={busy || !date || !time || !cabinet} onClick={save}>{busy ? t('common.wait') : t('book.save')}</button>
      </div>
    </div>
  );
}
