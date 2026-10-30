'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { fmtDateTime } from '../../../lib/ui';
import { useI18n } from '../../../lib/i18n';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';
import { useConfirm } from '../../../components/ConfirmDialog';

interface Entry {
  id: string;
  patient: { id: string; fullName: string; phone: string | null };
  doctorName: string | null;
  weekdays: number[];
  fromHour: number;
  toHour: number;
  note: string | null;
  status: 'ACTIVE' | 'OFFERED' | 'DONE';
  expiresAt: string;
  canBeOffered: boolean;
  lastOffer: { status: string; startsAt: string; expiresAt: string } | null;
}
interface PatientRow {
  id: string;
  fullName: string;
  phone: string | null;
}

// The waiting list: who waits for a time and what was offered. Offers go out through the approval queue over Telegram.
export default function WaitlistPage() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<PatientRow[]>([]);
  const [patient, setPatient] = useState<PatientRow | null>(null);
  const [from, setFrom] = useState(9);
  const [to, setTo] = useState(20);
  const [days, setDays] = useState<number[]>([]);
  const [doctor, setDoctor] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(() => api<Entry[]>('/waitlist').then(setRows).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);
  useEffect(() => {
    if (search.trim().length < 2) return setFound([]);
    const id = setTimeout(() => api<{ rows: PatientRow[] }>(`/patients?search=${encodeURIComponent(search.trim())}`).then((r) => setFound(r.rows.slice(0, 5))).catch(() => setFound([])), 300);
    return () => clearTimeout(id);
  }, [search]);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!rows) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  const wd = (n: number) => t(`ins.wd${n}` as 'ins.wd1');
  const wishes = (e: Entry) => [e.doctorName ?? t('wl.anyDoctor'), e.weekdays.length ? e.weekdays.map(wd).join(', ') : t('wl.anyDay'), `${e.fromHour}:00–${e.toHour}:00`].join(' · ');

  return (
    <>
      {dialog}
      <PageHeader title={t('wl.title')} subtitle={t('wl.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <Alert tone="info">{t('wl.rules')}</Alert>

      <Card title={t('wl.add')}>
        {patient ? (
          <p className="rule" style={{ marginTop: 0 }}>
            <b>{patient.fullName}</b> {patient.phone ? `· ${patient.phone}` : ''} <button className="btn btn-sm" onClick={() => setPatient(null)}>{t('wl.change')}</button>
          </p>
        ) : (
          <>
            <input className="input" placeholder={t('inbox.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
            {found.map((p) => (
              <button key={p.id} className="btn" style={{ marginTop: 6, width: '100%', justifyContent: 'flex-start' }} onClick={() => { setPatient(p); setSearch(''); setFound([]); }}>
                {p.fullName} {p.phone ? `· ${p.phone}` : ''}
              </button>
            ))}
          </>
        )}
        <div className="toolbar" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0 }}><span>{t('wl.from')}</span><input className="input" type="number" min={0} max={23} style={{ width: 90 }} value={from} onChange={(e) => setFrom(Number(e.target.value))} /></label>
          <label className="field" style={{ margin: 0 }}><span>{t('wl.to')}</span><input className="input" type="number" min={1} max={24} style={{ width: 90 }} value={to} onChange={(e) => setTo(Number(e.target.value))} /></label>
          <label className="field grow" style={{ margin: 0 }}><span>{t('wl.doctor')}</span><input className="input" value={doctor} maxLength={120} onChange={(e) => setDoctor(e.target.value)} placeholder={t('wl.doctorHint')} /></label>
        </div>
        <p className="rule">{t('wl.days')}</p>
        <div className="toolbar">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <button key={d} className={days.includes(d) ? 'btn btn-sm btn-primary' : 'btn btn-sm'} aria-pressed={days.includes(d)} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}>{wd(d)}</button>
          ))}
        </div>
        <label className="field"><span>{t('wl.note')}</span><input className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={busy || !patient} onClick={() => act(async () => { await api('/waitlist', { method: 'POST', body: JSON.stringify({ patientId: patient!.id, fromHour: from, toHour: to, weekdays: days, doctorName: doctor.trim() || null, note: note.trim() || null }) }); setPatient(null); setDays([]); setDoctor(''); setNote(''); }, t('wl.added'))}>{t('wl.addBtn')}</button>
      </Card>

      <Card flush title={t('wl.listTitle')}>
        {rows.length === 0 ? (
          <Empty title={t('wl.empty')}>{t('wl.emptyHint')}</Empty>
        ) : (
          rows.map((e) => (
            <div key={e.id} className="req-item">
              <span className="chat-name">
                <Link href={`/patients/${e.patient.id}`}><b>{e.patient.fullName}</b></Link>
                {e.status === 'OFFERED' && <Badge tone="blue">{t('wl.st.OFFERED')}</Badge>}
                {e.status === 'DONE' && <Badge tone="green">{t('wl.st.DONE')}</Badge>}
                {e.status === 'ACTIVE' && <Badge tone="amber">{t('wl.st.ACTIVE')}</Badge>}
                {!e.canBeOffered && e.status === 'ACTIVE' && <Badge tone="red">{t('wl.noTelegram')}</Badge>}
              </span>
              <span>{wishes(e)}{e.note ? ` · ${e.note}` : ''}</span>
              {e.lastOffer && <span className="muted chat-time">{t('wl.lastOffer')}: {fmtDateTime(e.lastOffer.startsAt)} · {e.lastOffer.status}</span>}
              {e.status !== 'DONE' && (
                <div className="toolbar">
                  <button className="btn btn-sm" disabled={busy} onClick={async () => (await ask(t('wl.removeConfirm'), { danger: true, confirmLabel: t('wl.remove') })) && act(() => api(`/waitlist/${e.id}`, { method: 'DELETE' }))}>{t('wl.remove')}</button>
                </div>
              )}
            </div>
          ))
        )}
      </Card>
    </>
  );
}
