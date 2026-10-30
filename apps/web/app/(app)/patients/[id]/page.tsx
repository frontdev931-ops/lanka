'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '../../../../lib/api';
import { useI18n } from '../../../../lib/i18n';
import { fmtDate, fmtDateTime, fmtNumber, initials } from '../../../../lib/ui';
import { Alert, Badge, Card, Empty, Icon, Loading, resultTone, statusTone } from '../../../../components/ui';
import { QrCode } from '../../../../components/QrCode';

interface Patient {
  id: string;
  fullName: string;
  phone: string | null;
  source: string | null;
  preferredContact: string | null;
  lastVisitAt: string | null;
  removedAt?: string | null;
  balanceIssued?: string | null;
  balancePaid?: string | null;
  consent: 'UNKNOWN' | 'GIVEN' | 'WITHDRAWN';
  consentNote: string | null;
  automationPaused: boolean;
  extra: Record<string, { v: string; b: string }>;
  channels?: { channel: string; username: string | null; optedOutAt: string | null }[];
  outbox?: { id: string; ruleKey: string; status: string; text: string; scheduledFor: string; sentAt: string | null; error: string | null }[];
  visits: { id: string; startsAt: string; status: string; doctorName: string | null; serviceName: string | null; amount?: string | null }[];
  tasks: { id: string; title: string; status: string; result: string | null; dueDate: string; assignee: { name: string } | null }[];
  contacts: { id: string; channel: string; outcome: string | null; note: string | null; source: string; contactedAt: string; user: { name: string } | null }[];
}

const CHANNELS = ['PHONE', 'MESSENGER', 'SMS', 'EMAIL', 'VISIT', 'OTHER'];
const OUTCOMES = ['BOOKED', 'CALL_LATER', 'NO_ANSWER', 'DECLINED'];

export default function PatientPage() {
  const { id } = useParams<{ id: string }>();
  const { t, label } = useI18n();
  const [p, setP] = useState<Patient | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [tgLink, setTgLink] = useState('');
  const [tgError, setTgError] = useState('');
  const [consent, setConsent] = useState<Patient['consent']>('UNKNOWN');
  const [consentNote, setConsentNote] = useState('');
  const [paused, setPaused] = useState(false);

  const load = useCallback(() => {
    api<Patient>(`/patients/${id}`)
      .then((d) => {
        setP(d);
        setConsent(d.consent);
        setConsentNote(d.consentNote ?? '');
        setPaused(d.automationPaused);
      })
      .catch((e) => setError((e as Error).message));
  }, [id]);
  useEffect(load, [load]);

  async function addTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      await api('/tasks', { method: 'POST', body: JSON.stringify({ title: f.title, patientId: id, dueDate: f.dueDate || undefined }) });
      form.reset();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function addContact(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setError('');
    try {
      await api(`/patients/${id}/contacts`, {
        method: 'POST',
        body: JSON.stringify({ channel: f.channel, outcome: f.outcome || undefined, note: f.note || undefined }),
      });
      form.reset();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function saveConsent() {
    setError('');
    setInfo('');
    try {
      await api(`/patients/${id}/consent`, { method: 'PATCH', body: JSON.stringify({ consent, note: consentNote, automationPaused: paused }) });
      setInfo(t('common.saved'));
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (error && !p) return <Alert tone="error">{error}</Alert>;
  if (!p) return <Loading />;

  // Врачу сервер деньги пациента не отдаёт
  const showMoney = p.balanceIssued !== undefined;
  const issued = Number(p.balanceIssued ?? 0);
  const paid = Number(p.balancePaid ?? 0);
  const debt = issued - paid > 0 ? fmtNumber(Math.round((issued - paid) * 100) / 100) : null;
  const extra = Object.entries(p.extra ?? {});
  const consentTone = p.consent === 'GIVEN' ? 'green' : p.consent === 'WITHDRAWN' ? 'red' : 'gray';

  const patientId = p.id;
  async function makeTgLink() {
    setTgError('');
    try {
      setTgLink((await api<{ url: string }>(`/automations/patients/${patientId}/telegram-link`, { method: 'POST' })).url);
    } catch (e) {
      setTgError((e as Error).message);
    }
  }
  const tg = p.channels?.find((c) => c.channel === 'TELEGRAM');

  return (
    <>
      <p style={{ marginTop: 0 }}>
        <Link href="/patients"><Icon name="back" size={14} /> {t('pd.all')}</Link>
      </p>
      {p.removedAt && <Alert tone="warn">{t('pd.removed')}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      <Card>
        <div className="patient-head">
          <span className="avatar lg">{initials(p.fullName)}</span>
          <div>
            <h1 style={{ fontSize: 24 }}>{p.fullName}</h1>
            <span className="muted">{p.phone ?? t('pd.noPhone')}</span>
            <div style={{ marginTop: 6 }} className="toolbar">
              <Badge tone={consentTone}>{label('consent', p.consent)}</Badge>
              {p.automationPaused && <Badge tone="amber">{t('pd.automationPaused')}</Badge>}
            </div>
          </div>
        </div>
        <dl className="info-grid">
          <div><dt>{t('pd.source')}</dt><dd>{p.source ?? '—'}</dd></div>
          <div><dt>{t('pd.contact')}</dt><dd>{p.preferredContact ?? '—'}</dd></div>
          <div><dt>{t('pd.lastVisit')}</dt><dd>{fmtDate(p.lastVisitAt)}</dd></div>
          {showMoney && (
            <>
              <div><dt>{t('pd.billed')}</dt><dd>{p.balanceIssued ? fmtNumber(issued) : '—'}</dd></div>
              <div><dt>{t('pd.paid')}</dt><dd>{p.balancePaid ? fmtNumber(paid) : '—'}</dd></div>
              <div><dt>{t('pd.debt')}</dt><dd>{debt ? <Badge tone="amber">{debt}</Badge> : '0'}</dd></div>
            </>
          )}
        </dl>
      </Card>

      <Card title={t('pd.consent')}>
        <p className="rule">{t('pd.consentHint')}</p>
        <div className="form-grid">
          <div className="field">
            <select className="select" value={consent} onChange={(e) => setConsent(e.target.value as Patient['consent'])} aria-label={t('pd.consent')}>
              {['UNKNOWN', 'GIVEN', 'WITHDRAWN'].map((c) => <option key={c} value={c}>{label('consent', c)}</option>)}
            </select>
          </div>
          <div className="field">
            <input className="input" value={consentNote} maxLength={500} placeholder={t('pd.consentNote')} onChange={(e) => setConsentNote(e.target.value)} />
          </div>
        </div>
        <div className="toolbar">
          <label className="checkbox"><input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} /> {t('pd.automationPaused')}</label>
          <button className="btn btn-primary" onClick={saveConsent}>{t('common.save')}</button>
        </div>
      </Card>

      <Card title={t('pd.msgTitle')}>
        <p className="rule">
          {tg && !tg.optedOutAt ? <Badge tone="green">{t('pd.tgOn')}{tg.username ? ` @${tg.username}` : ''}</Badge> : tg ? <Badge tone="red">{t('pd.tgOff')}</Badge> : <Badge tone="gray">{t('pd.tgNone')}</Badge>}
        </p>
        {(!tg || tg.optedOutAt) && (
          <>
            <div className="toolbar">
              <button className="btn btn-sm" onClick={makeTgLink}>{t('pd.tgConnect')}</button>
            </div>
            {tgError && <Alert tone="error">{tgError}</Alert>}
            {tgLink && (
              <div className="toolbar" style={{ alignItems: 'flex-start', gap: 16, marginTop: 10 }}>
                <QrCode value={tgLink} size={150} label={t('au.tgQr')} />
                <div style={{ minWidth: 0 }}>
                  <p className="rule" style={{ marginTop: 0 }}>{t('pd.tgScan')}</p>
                  <input className="input" style={{ width: '100%', maxWidth: 420 }} readOnly value={tgLink} onFocus={(e) => e.currentTarget.select()} aria-label={t('au.tgQr')} />
                </div>
              </div>
            )}
          </>
        )}
        {p.outbox && p.outbox.length > 0 && (
          <div className="msg-history">
            {p.outbox.map((m) => (
              <div key={m.id} className="msg-item">
                <div className="cell-sub">
                  {fmtDateTime(m.sentAt ?? m.scheduledFor)} · {t(`au.r.${m.ruleKey}` as never)} · <Badge tone={m.status === 'SENT' ? 'green' : m.status === 'FAILED' ? 'red' : m.status === 'PENDING_APPROVAL' ? 'amber' : 'gray'}>{t(`au.st.${m.status}` as never)}</Badge>
                </div>
                <div>{m.text}</div>
                {m.error && <div className="cell-sub">{m.error}</div>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={t('pd.contacts')}>
        <form onSubmit={addContact} className="toolbar" style={{ marginBottom: 8 }}>
          <select className="select" name="channel" defaultValue="PHONE" aria-label={t('pd.channel')}>
            {CHANNELS.map((c) => <option key={c} value={c}>{label('channel', c)}</option>)}
          </select>
          <select className="select" name="outcome" defaultValue="" aria-label={t('pd.outcome')}>
            <option value="">{t('pd.noOutcome')}</option>
            {OUTCOMES.map((o) => <option key={o} value={o}>{label('result', o)}</option>)}
          </select>
          <input className="input grow" name="note" maxLength={1000} placeholder={t('pd.note')} />
          <button type="submit" className="btn btn-primary"><Icon name="plus" size={16} /> {t('pd.addContact')}</button>
        </form>
        {p.contacts.length ? (
          <ul className="timeline">
            {p.contacts.map((c) => (
              <li key={c.id}>
                <span>
                  <span className="cell-main">{label('channel', c.channel)}</span>
                  {c.note && <div className="cell-sub">{c.note}</div>}
                  <div className="cell-sub">{fmtDateTime(c.contactedAt)}{c.user ? ` · ${c.user.name}` : ''} · {label('src', c.source)}</div>
                </span>
                {c.outcome && <Badge tone={resultTone(c.outcome)}>{label('result', c.outcome)}</Badge>}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={t('pd.noContacts')} />
        )}
      </Card>

      {extra.length > 0 && (
        <Card title={t('pd.extra')}>
          <p className="rule">{t('pd.extraHint')}</p>
          <dl className="kv">
            {extra.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v.v}</dd></div>)}
          </dl>
        </Card>
      )}

      <Card title={t('pd.tasks')}>
        <form onSubmit={addTask} className="toolbar" style={{ marginBottom: 8 }}>
          <input className="input grow" name="title" placeholder={t('pd.newTask')} required minLength={2} />
          <input className="input" name="dueDate" type="date" />
          <button type="submit" className="btn btn-primary"><Icon name="plus" size={16} /> {t('common.add')}</button>
        </form>
        {p.tasks.length ? (
          <ul className="list">
            {p.tasks.map((task) => (
              <li key={task.id}>
                <span>
                  <span className="cell-main">{task.title}</span>
                  <div className="cell-sub">{t('pd.due', { date: fmtDate(task.dueDate) })}{task.assignee && ` · ${task.assignee.name}`}</div>
                </span>
                <span className="toolbar">
                  {task.result && <Badge tone={resultTone(task.result)}>{label('result', task.result)}</Badge>}
                  <Badge tone={task.status === 'OPEN' ? 'blue' : 'gray'}>{task.status === 'OPEN' ? t('pd.open') : t('pd.closed')}</Badge>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={t('pd.noTasks')} />
        )}
      </Card>

      <Card flush title={t('pd.visits')}>
        {p.visits.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('pd.colDate')}</th><th>{t('pd.colStatus')}</th><th>{t('pd.colDoctor')}</th>
                  <th>{t('pd.colServices')}</th>{showMoney && <th className="num">{t('pd.colAmount')}</th>}
                </tr>
              </thead>
              <tbody>
                {p.visits.map((v) => (
                  <tr key={v.id}>
                    <td>{fmtDateTime(v.startsAt)}</td>
                    <td><Badge tone={statusTone(v.status)}>{label('status', v.status)}</Badge></td>
                    <td>{v.doctorName ?? <span className="muted">—</span>}</td>
                    <td>{v.serviceName ?? <span className="muted">—</span>}</td>
                    {showMoney && <td className="num">{v.amount ? fmtNumber(v.amount) : <span className="muted">—</span>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={t('pd.noVisits')} />
        )}
      </Card>
    </>
  );
}
