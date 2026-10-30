'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { fmtDateTime } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';
import { BookingForm } from '../../../components/BookingForm';

interface Conv {
  channel: string;
  chatId: string;
  patient: { id: string; fullName: string } | null;
  contactName: string | null;
  lastText: string;
  lastDirection: 'IN' | 'OUT';
  lastAt: string;
  unread: number;
}
interface Thread {
  channel: string;
  chatId: string;
  patient: { id: string; fullName: string } | null;
  contactName: string | null;
  optedOut: boolean;
  replyWindowOpen: boolean;
  messages: { id: string; direction: 'IN' | 'OUT'; text: string; createdAt: string; error: string | null; system: boolean; byAi: boolean }[];
}
interface Draft {
  intent: string;
  reply: string;
  handoff: boolean;
  reason: string | null;
}
interface Req {
  id: string;
  channel: string;
  chatId: string;
  contactName: string | null;
  kind: 'BOOKING' | 'RESCHEDULE' | 'CANCEL' | 'HANDOFF' | 'REVIEW';
  summary: string;
  status: 'NEW' | 'DONE' | 'DISMISSED';
  createdAt: string;
  patient: { id: string; fullName: string; phone: string | null } | null;
}
interface PatientRow {
  id: string;
  fullName: string;
  phone: string | null;
}

export default function InboxPage() {
  const { t } = useI18n();
  const [list, setList] = useState<Conv[] | null>(null);
  const [open, setOpen] = useState<{ channel: string; chatId: string } | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<PatientRow[]>([]);
  const [draftInfo, setDraftInfo] = useState<Draft | null>(null);
  const [tab, setTab] = useState<'chats' | 'requests'>('chats');
  const [reqStatus, setReqStatus] = useState<'NEW' | 'DONE'>('NEW');
  const [reqs, setReqs] = useState<{ newCount: number; rows: Req[] } | null>(null);
  const [bookingOn, setBookingOn] = useState(false);
  const [bookingFor, setBookingFor] = useState<string | null>(null);
  useEffect(() => {
    api<{ enabled: boolean }>('/bookings/status').then((s) => setBookingOn(s.enabled)).catch(() => undefined);
  }, []);

  const loadList = useCallback(() => api<Conv[]>('/conversations').then(setList).catch((e) => setError((e as Error).message)), []);
  const loadThread = useCallback(
    (c: { channel: string; chatId: string }) => api<Thread>(`/conversations/${c.channel}/${c.chatId}`).then((th) => { setThread(th); loadList(); }).catch((e) => setError((e as Error).message)),
    [loadList],
  );

  const loadReqs = useCallback(() => api<{ newCount: number; rows: Req[] }>(`/requests?status=${reqStatus}`).then(setReqs).catch((e) => setError((e as Error).message)), [reqStatus]);
  useEffect(() => {
    loadReqs();
    const id = setInterval(loadReqs, 15000);
    return () => clearInterval(id);
  }, [loadReqs]);
  const closeReq = async (id: string, status: 'DONE' | 'DISMISSED' | 'NEW') => {
    setBusy(true);
    try {
      await api(`/requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await loadReqs();
      window.dispatchEvent(new Event('stomat:requests-changed'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    loadList();
    const id = setInterval(loadList, 15000);
    return () => clearInterval(id);
  }, [loadList]);

  useEffect(() => {
    setDraftInfo(null);
    if (!open) return setThread(null);
    loadThread(open);
    const id = setInterval(() => loadThread(open), 15000);
    return () => clearInterval(id);
  }, [open, loadThread]);

  useEffect(() => {
    if (search.trim().length < 2) return setFound([]);
    const id = setTimeout(() => api<{ rows: PatientRow[] }>(`/patients?search=${encodeURIComponent(search.trim())}`).then((r) => setFound(r.rows.slice(0, 5))).catch(() => setFound([])), 300);
    return () => clearTimeout(id);
  }, [search]);

  const send = async () => {
    if (!open || !text.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api(`/conversations/${open.channel}/${open.chatId}/reply`, { method: 'POST', body: JSON.stringify({ text }) });
      setText('');
      await loadThread(open);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const makeDraft = async () => {
    if (!open) return;
    setBusy(true);
    setError('');
    try {
      const d = await api<Draft>(`/conversations/${open.channel}/${open.chatId}/draft`, { method: 'POST' });
      setDraftInfo(d);
      setText(d.reply);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const link = async (patientId: string) => {
    if (!open) return;
    setBusy(true);
    try {
      await api(`/conversations/${open.channel}/${open.chatId}/link`, { method: 'POST', body: JSON.stringify({ patientId }) });
      setSearch('');
      setFound([]);
      await loadThread(open);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!list) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  const name = (c: { patient: { fullName: string } | null; contactName: string | null }) => c.patient?.fullName ?? c.contactName ?? t('inbox.unknown');

  return (
    <>
      <PageHeader title={t('inbox.title')} subtitle={t('inbox.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}

      {!open && (
        <div className="tabs-row" role="tablist">
          <button className={tab === 'chats' ? 'btn btn-primary' : 'btn'} role="tab" aria-selected={tab === 'chats'} onClick={() => setTab('chats')}>{t('inbox.tabChats')}</button>
          <button className={tab === 'requests' ? 'btn btn-primary' : 'btn'} role="tab" aria-selected={tab === 'requests'} onClick={() => setTab('requests')}>
            {t('inbox.tabRequests')}{reqs && reqs.newCount > 0 ? ` (${reqs.newCount})` : ''}
          </button>
        </div>
      )}

      {!open && tab === 'requests' && (
        <Card
          flush
          title={t('inbox.reqTitle')}
          actions={
            <>
              <button className={reqStatus === 'NEW' ? 'btn btn-sm btn-primary' : 'btn btn-sm'} onClick={() => setReqStatus('NEW')}>{t('inbox.reqNew')}</button>
              <button className={reqStatus === 'DONE' ? 'btn btn-sm btn-primary' : 'btn btn-sm'} onClick={() => setReqStatus('DONE')}>{t('inbox.reqDone')}</button>
            </>
          }
        >
          {!reqs ? (
            <Loading />
          ) : reqs.rows.length === 0 ? (
            <Empty title={t('inbox.reqEmpty')}>{t('inbox.reqEmptyHint')}</Empty>
          ) : (
            reqs.rows.map((r) => (
              <div key={r.id} className="req-item">
                <span className="chat-name">
                  <b>{r.patient?.fullName ?? r.contactName ?? t('inbox.unknown')}</b>
                  <Badge tone={r.kind === 'HANDOFF' ? 'amber' : 'blue'}>{t(`inbox.kind.${r.kind}`)}</Badge>
                  {r.patient?.phone && <span className="muted">{r.patient.phone}</span>}
                </span>
                <span>{r.summary}</span>
                <span className="muted chat-time">{fmtDateTime(r.createdAt)}</span>
                <div className="toolbar">
                  <button className="btn btn-sm" onClick={() => { setOpen({ channel: r.channel, chatId: r.chatId }); setTab('chats'); }}>{t('inbox.openChat')}</button>
                  {r.status === 'NEW' && bookingOn && r.patient && (r.kind === 'BOOKING' || r.kind === 'RESCHEDULE') && (
                    <button className="btn btn-sm" onClick={() => setBookingFor(bookingFor === r.id ? null : r.id)}>{t('book.open')}</button>
                  )}
                  {r.status === 'NEW' ? (
                    <>
                      <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => closeReq(r.id, 'DONE')}>{t('inbox.reqMarkDone')}</button>
                      <button className="btn btn-sm" disabled={busy} onClick={() => closeReq(r.id, 'DISMISSED')}>{t('inbox.reqDismiss')}</button>
                    </>
                  ) : (
                    <button className="btn btn-sm" disabled={busy} onClick={() => closeReq(r.id, 'NEW')}>{t('inbox.reqReopen')}</button>
                  )}
                </div>
                {bookingFor === r.id && r.patient && <BookingForm patientId={r.patient.id} requestId={r.id} onDone={() => { setBookingFor(null); loadReqs(); }} />}
              </div>
            ))
          )}
        </Card>
      )}

      {!open && tab === 'chats' && (
        <Card flush>
          {list.length === 0 ? (
            <Empty title={t('inbox.empty')}>{t('inbox.emptyHint')}</Empty>
          ) : (
            <ul className="chat-list">
              {list.map((c) => (
                <li key={`${c.channel}:${c.chatId}`}>
                  <button className="chat-item" onClick={() => setOpen({ channel: c.channel, chatId: c.chatId })}>
                    <span className="chat-name">
                      <b>{name(c)}</b>
                      {c.channel !== 'TELEGRAM' && <Badge tone="blue">{({ INSTAGRAM: 'Instagram', MESSENGER: 'Messenger', WHATSAPP: 'WhatsApp', VIBER: 'Viber', WEB: 'Web' } as Record<string, string>)[c.channel] ?? c.channel}</Badge>}
                      {!c.patient && <Badge tone="amber">{t('inbox.notLinked')}</Badge>}
                      {c.unread > 0 && <Badge tone="blue">{c.unread}</Badge>}
                    </span>
                    <span className="muted chat-last">{c.lastDirection === 'OUT' ? `${t('inbox.you')}: ` : ''}{c.lastText}</span>
                    <span className="muted chat-time">{fmtDateTime(c.lastAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {open && (
        <Card
          title={thread ? name(thread) : '…'}
          actions={<button className="btn btn-sm" onClick={() => { setOpen(null); setError(''); }}>{t('inbox.back')}</button>}
        >
          {!thread ? (
            <Loading />
          ) : (
            <>
              {thread.patient ? (
                <p className="rule" style={{ marginTop: 0 }}>
                  <Link href={`/patients/${thread.patient.id}`}>{t('inbox.openCard')}</Link>
                </p>
              ) : (
                <div className="chat-link">
                  <p className="rule" style={{ marginTop: 0 }}>{t('inbox.linkHint')}</p>
                  <input className="input" placeholder={t('inbox.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
                  {found.map((p) => (
                    <button key={p.id} className="btn" disabled={busy} style={{ marginTop: 6, width: '100%', justifyContent: 'flex-start' }} onClick={() => link(p.id)}>
                      {p.fullName} {p.phone ? `· ${p.phone}` : ''}
                    </button>
                  ))}
                </div>
              )}
              {thread.optedOut && <Alert tone="warn">{t('inbox.optedOut')}</Alert>}
              {!thread.replyWindowOpen && <Alert tone="warn">{t('inbox.windowClosed')}</Alert>}
              <div className="chat-thread">
                {thread.messages.map((m) => (
                  <div key={m.id} className={`bubble ${m.direction === 'IN' ? 'in' : 'out'}`}>
                    <div>{m.text}</div>
                    <div className="muted bubble-meta">
                      {m.byAi ? `${t('inbox.byAi')} · ` : m.system ? `${t('inbox.auto')} · ` : ''}
                      {fmtDateTime(m.createdAt)}
                      {m.error ? ` · ${m.error}` : ''}
                    </div>
                  </div>
                ))}
              </div>
              <div className="toolbar" style={{ marginBottom: 8 }}>
                <button className="btn" disabled={busy || thread.optedOut || !thread.replyWindowOpen || thread.messages[thread.messages.length - 1]?.direction !== 'IN'} onClick={makeDraft}>
                  {t('inbox.draft')}
                </button>
              </div>
              <label className="field">
                <span>{t('inbox.reply')}</span>
                <textarea className="input" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} disabled={thread.optedOut} />
              </label>
              {draftInfo && <Alert tone={draftInfo.handoff ? 'warn' : 'info'}>{draftInfo.handoff ? t('inbox.draftHandoff') : t('inbox.draftReady')}</Alert>}
              <div className="toolbar">
                <button className="btn btn-primary" disabled={busy || thread.optedOut || !thread.replyWindowOpen || !text.trim()} onClick={send}>
                  {t('inbox.send')}
                </button>
              </div>
              <p className="muted" style={{ fontSize: 13 }}>{t('inbox.sendNote')}</p>
            </>
          )}
        </Card>
      )}
    </>
  );
}
