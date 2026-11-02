'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert } from './ui';

interface Match {
  found: boolean;
  reason: 'no_time' | 'no_patient' | 'no_visit' | null;
  source?: 'cliniccards' | 'local';
  visits: { externalId: string; date: string; time: string; doctor: string | null; service: string | null; status: string }[];
}

interface Initial {
  date: string;
  time: string;
  service: string;
  doctor: string;
}

// "Entered in Cliniccards": the administrator states the real booking (prefilled with what the person chose, or with the visit found in
// Cliniccards) and the client is told these values. Nothing is written to Cliniccards from here.
export function RequestConfirm({ requestId, initial, onDone, onCancel }: { requestId: string; initial: Initial; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [match, setMatch] = useState<Match | null>(null);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [service, setService] = useState(initial.service);
  const [doctor, setDoctor] = useState(initial.doctor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Match>(`/requests/${requestId}/match`)
      .then((m) => {
        setMatch(m);
        // the visit that really exists in Cliniccards wins over what the person chose
        const v = m.visits[0];
        if (v) {
          setDate(v.date);
          setTime(v.time);
          if (v.service) setService(v.service);
          if (v.doctor) setDoctor(v.doctor);
        }
      })
      .catch(() => setMatch({ found: false, reason: null, visits: [] }));
  }, [requestId]);

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      await api(`/requests/${requestId}/confirm`, { method: 'POST', body: JSON.stringify({ date, time, ...(service.trim() ? { service: service.trim() } : {}), ...(doctor.trim() ? { doctor: doctor.trim() } : {}) }) });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-link">
      {error && <Alert tone="error">{error}</Alert>}
      {!match ? (
        <p className="rule" style={{ marginTop: 0 }}>{t('confirm.checking')}</p>
      ) : match.found ? (
        <Alert tone="success">{t('confirm.found')}</Alert>
      ) : (
        <Alert tone="warn">{t('confirm.manual')}</Alert>
      )}
      <p className="rule" style={{ marginTop: 0 }}>{t('confirm.hint')}</p>
      <div className="toolbar">
        <label className="field" style={{ margin: 0 }}><span>{t('book.date')}</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field" style={{ margin: 0 }}><span>{t('book.time')}</span><input className="input" type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} /></label>
        <label className="field" style={{ margin: 0 }}><span>{t('confirm.service')}</span><input className="input" value={service} maxLength={120} onChange={(e) => setService(e.target.value)} /></label>
        <label className="field" style={{ margin: 0 }}><span>{t('confirm.doctor')}</span><input className="input" value={doctor} maxLength={80} onChange={(e) => setDoctor(e.target.value)} /></label>
      </div>
      <div className="toolbar">
        <button className="btn btn-primary" disabled={busy || !date || !time} onClick={confirm}>{busy ? t('common.wait') : t('confirm.submit')}</button>
        <button className="btn" disabled={busy} onClick={onCancel}>{t('common.back')}</button>
      </div>
    </div>
  );
}
