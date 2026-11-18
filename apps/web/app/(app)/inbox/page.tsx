'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { fmtDateTime } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';
import { BookingForm } from '../../../components/BookingForm';
import { RequestConfirm } from '../../../components/RequestConfirm';
import { AgentDraftPanel, AgentDraftView, Choice, Note, TKey } from '../../../components/AgentDraftPanel';

// How a channel is named to staff; Telegram is the default one and has no badge in the list
const CHANNEL_NAME: Record<string, string> = { TELEGRAM: 'Telegram', INSTAGRAM: 'Instagram', MESSENGER: 'Messenger', WHATSAPP: 'WhatsApp', VIBER: 'Viber', WEB: 'Web' };
// Channels where an answer is allowed only within 24 hours after the person's last message
const WINDOW_CHANNELS = new Set(['INSTAGRAM', 'MESSENGER', 'WHATSAPP']);

interface Conv {
  channel: string;
  chatId: string;
  patient: { id: string; fullName: string } | null;
  contactName: string | null;
  lastText: string;
  lastDirection: 'IN' | 'OUT';
  lastAt: string;
  unread: number;
  // who answers the next message by itself (the server's label; the senders check everything again)
  answers?: 'AI' | 'STAFF';
}
interface Thread {
  channel: string;
  chatId: string;
  patient: { id: string; fullName: string } | null;
  contactName: string | null;
  optedOut: boolean;
  replyWindowOpen: boolean;
  botPausedUntil: string | null;
  agentOwnerHuman?: boolean;
  dialogKey?: string;
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
  service: string | null;
  doctor: string | null;
  slotAt: string | null;
  fullName: string | null;
  phone: string | null;
  confirmedAt: string | null;
  confirmedBy: 'ADMIN' | 'AUTO' | null;
  confirmSource: 'CLINICCARDS' | 'MANUAL' | 'AUTO' | null;
  confirmedStartsAt: string | null;
  noticeStatus: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED' | null;
  noticeError: string | null;
  noticeAt: string | null;
  blockCode?: string | null;
}
interface PatientRow {
  id: string;
  fullName: string;
  phone: string | null;
}

export default function InboxPage() {
  const { t } = useI18n();
  // the website chat says "Website" in the clinic's language
  const chName = (c: string) => (c === 'WEB' ? t('chs.tab.website') : c ? (CHANNEL_NAME[c] ?? c) : '');
  const [list, setList] = useState<Conv[] | null>(null);
  const [open, setOpen] = useState<{ channel: string; chatId: string } | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  // The open conversation starts at its newest message, like a messenger. A new message moves it down only when the person was already near the bottom
  // (reading older messages is not interrupted).
  const threadRef = useRef<HTMLDivElement>(null);
  const shownChat = useRef<string | null>(null);
  // was the person at the bottom before the last change (measured on scroll, before new messages make the list taller)
  const atBottom = useRef(true);
  const msgCount = thread?.messages.length ?? 0;
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el || !open || !thread) return;
    const key = `${open.channel}:${open.chatId}`;
    if (shownChat.current !== key || atBottom.current) el.scrollTop = el.scrollHeight;
    shownChat.current = key;
  }, [open, thread, msgCount]);
  useEffect(() => {
    if (!open) shownChat.current = null;
  }, [open]);
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<PatientRow[]>([]);
  const [draftInfo, setDraftInfo] = useState<Draft | null>(null);
  // the agent's draft kept on the server for review (only in a clinic with the agent switched on)
  const [agentDraft, setAgentDraft] = useState<AgentDraftView | null>(null);
  const [agentNote, setAgentNote] = useState<Note>(null);
  // the request whose confirmation message was not delivered (the visit exists): the existing safe retry
  const [noticeRetry, setNoticeRetry] = useState<string | null>(null);
  const [tab, setTab] = useState<'chats' | 'requests'>('chats');
  // the channel filter of the list of dialogues ('' = all); offered only when the clinic has dialogues in more than one channel
  const [chFilter, setChFilter] = useState('');
  // the home page's "new requests" card opens the requests tab (/inbox?tab=requests)
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'requests') setTab('requests');
  }, []);
  const [reqStatus, setReqStatus] = useState<'NEW' | 'DONE'>('NEW');
  const [reqs, setReqs] = useState<{ newCount: number; rows: Req[] } | null>(null);
  const [bookingOn, setBookingOn] = useState(false);
  const [bookingFor, setBookingFor] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
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

  const resumeBot = async () => {
    if (!open) return;
    setBusy(true);
    try {
      await api(`/conversations/${open.channel}/${open.chatId}/resume-bot`, { method: 'POST' });
      await loadThread(open);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const retryNotice = async (id: string, force: boolean) => {
    setBusy(true);
    try {
      await api(`/requests/${id}/notice/retry`, { method: 'POST', body: JSON.stringify({ force }) });
      await loadReqs();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // The time the bot offered or the person chose, in the clinic's local time, for the confirm form
  const localParts = (iso: string | null) => {
    if (!iso) return { date: '', time: '' };
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
    const g = (k: string) => p.find((x) => x.type === k)?.value ?? '';
    return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
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
      const d = await api<Draft & Partial<AgentDraftView> & { agent?: boolean }>(`/conversations/${open.channel}/${open.chatId}/draft`, { method: 'POST' });
      if (d.agent) {
        // the agent's draft: shown for review, nothing is put into the reply field and nothing is sent
        setAgentDraft(d as AgentDraftView);
        setAgentNote(null);
        setDraftInfo(null);
      } else {
        setDraftInfo(d);
        setText(d.reply);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // restore a waiting draft of this chat (and its freshness) when the dialogue is opened or refreshed
  const loadAgent = useCallback(async () => {
    if (!open) return;
    try {
      const r = await api<{ draft: AgentDraftView | null }>(`/agent-drafts/latest?channel=${encodeURIComponent(open.channel)}&chatId=${encodeURIComponent(open.chatId)}`);
      setAgentDraft(r.draft);
    } catch {
      setAgentDraft(null);
    }
  }, [open]);
  useEffect(() => {
    setAgentNote(null);
    void loadAgent();
    const id = setInterval(loadAgent, 12000);
    return () => clearInterval(id);
  }, [loadAgent]);

  const approveAgent = async (choice: Choice) => {
    if (!open || !agentDraft) return;
    setBusy(true);
    setAgentNote(null);
    try {
      const r = await api<{ ok: boolean; outcome: 'SENT' | 'FAILED' | 'UNKNOWN' | 'REFUSED'; code?: string; booking?: { visit: string | null; notice: string | null; requestId: string | null }; draft: AgentDraftView | null }>(`/agent-drafts/${agentDraft.id}/approve`, { method: 'POST', body: JSON.stringify({ revision: agentDraft.revision, choice }) });
      if (r.outcome === 'SENT') {
        setAgentDraft(null);
        if (r.booking) {
          // the visit and the message about it are separate results: a message that was not delivered does not undo the visit
          const ok = r.booking.notice === 'SENT';
          setAgentNote({ tone: ok ? 'success' : 'warn', key: ok ? 'agent.result.booked' : 'agent.result.bookedNoNotice' });
          setNoticeRetry(ok ? null : r.booking.requestId);
        } else setAgentNote({ tone: 'success', key: 'agent.result.sent' });
        await loadThread(open);
      } else if (r.outcome === 'FAILED') {
        setAgentDraft(null);
        setAgentNote({ tone: 'error', key: 'agent.result.failed' });
        await loadThread(open);
      } else if (r.outcome === 'UNKNOWN') {
        // not shown as a success and not sent again: the staff member checks the chat
        if (r.draft) setAgentDraft(r.draft);
        setAgentNote({ tone: 'warn', key: 'agent.result.unknown' });
        await loadThread(open);
      } else {
        // refused: nothing was sent. A changed draft (new times) is shown again for a new confirmation.
        if (r.draft) setAgentDraft(r.draft);
        setAgentNote({ tone: 'warn', key: `agent.code.${r.code ?? 'stale'}` });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resolveAgent = async (id: string, outcome: 'DELIVERED' | 'NOT_DELIVERED') => {
    if (!open) return;
    setBusy(true);
    try {
      await api(`/agent-drafts/${id}/resolve`, { method: 'POST', body: JSON.stringify({ outcome }) });
      setAgentNote({ tone: 'success', key: 'agent.verify.done' });
      await loadAgent();
      await loadThread(open);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const recheckAgent = async (id: string) => {
    if (!open) return;
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; outcome: 'SENT' | 'FAILED' | 'UNKNOWN' | 'REFUSED'; booking?: { notice: string | null; requestId: string | null }; draft: AgentDraftView | null }>(`/agent-drafts/${id}/recheck`, { method: 'POST', body: JSON.stringify({}) });
      if (r.outcome === 'SENT') {
        setAgentDraft(null);
        const ok = r.booking?.notice === 'SENT';
        setAgentNote({ tone: ok ? 'success' : 'warn', key: ok ? 'agent.result.booked' : 'agent.result.bookedNoNotice' });
        setNoticeRetry(ok ? null : (r.booking?.requestId ?? null));
      } else if (r.outcome === 'UNKNOWN') {
        if (r.draft) setAgentDraft(r.draft);
        setAgentNote({ tone: 'warn', key: 'agent.result.bookUnknown' });
      } else await loadAgent();
      await loadThread(open);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // the booking steps are made by the code from the request: "refresh" makes the step again for the state of the request now (no model call)
  const refreshStep = async () => {
    if (!open) return;
    setBusy(true);
    try {
      const r = await api<{ draft: AgentDraftView | null }>('/agent-drafts/refresh', { method: 'POST', body: JSON.stringify({ channel: open.channel, chatId: open.chatId }) });
      setAgentDraft(r.draft);
      setAgentNote(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const retryAgentNotice = async () => {
    if (!noticeRetry || !open) return;
    setBusy(true);
    try {
      await api(`/requests/${noticeRetry}/notice/retry`, { method: 'POST', body: JSON.stringify({}) });
      setNoticeRetry(null);
      setAgentNote({ tone: 'success', key: 'agent.result.booked' });
      await loadThread(open);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rejectAgent = async () => {
    if (!agentDraft) return;
    setBusy(true);
    try {
      await api(`/agent-drafts/${agentDraft.id}/reject`, { method: 'POST' });
      setAgentDraft(null);
      setAgentNote({ tone: 'info', key: 'agent.result.rejected' });
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
  const channels = [...new Set(list.map((c) => c.channel))];
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
                  <b>{r.patient?.fullName ?? r.fullName ?? r.contactName ?? t('inbox.unknown')}</b>
                  <Badge tone={r.kind === 'HANDOFF' ? 'amber' : 'blue'}>{t(`inbox.kind.${r.kind}`)}</Badge>
                  {(r.patient?.phone ?? r.phone) && <span className="muted">{r.patient?.phone ?? r.phone}</span>}
                </span>
                <span>{r.summary}</span>
                {r.blockCode && <span className="muted">{t('inbox.blockReason', { reason: t(`block.${r.blockCode}` as Parameters<typeof t>[0]) })}</span>}
                {r.confirmedAt && (
                  <span className="muted">
                    {r.confirmedBy === 'AUTO' ? t('confirm.byAuto') : t('confirm.byAdmin')}
                    {r.confirmSource === 'CLINICCARDS' ? ` · ${t('confirm.cliniccards')}` : r.confirmSource === 'MANUAL' ? ` · ${t('confirm.manualMark')}` : ''}
                  </span>
                )}
                {r.noticeStatus && (
                  <span>
                    <Badge tone={r.noticeStatus === 'SENT' ? 'green' : r.noticeStatus === 'PENDING' ? 'blue' : 'amber'}>
                      {t(`confirm.${r.noticeStatus === 'SENT' ? 'sent' : r.noticeStatus === 'FAILED' ? 'failed' : r.noticeStatus === 'SKIPPED' ? 'skipped' : 'pending'}`)}
                    </Badge>
                    {r.noticeError && <span className="muted"> {r.noticeError === 'window_closed' ? t('confirm.err.window_closed') : r.noticeError === 'not_connected' ? t('confirm.err.not_connected') : r.noticeError === 'sending_off' ? t('confirm.err.sending_off') : r.noticeError === 'opted_out' ? t('confirm.err.opted_out') : t('confirm.err.failed')}</span>}
                  </span>
                )}
                {r.status === 'NEW' && r.kind === 'RESCHEDULE' && <span className="muted">{t('inbox.rescheduleHint')}</span>}
                <span className="muted chat-time">{fmtDateTime(r.createdAt)}</span>
                <div className="toolbar">
                  <button className="btn btn-sm" onClick={() => { setOpen({ channel: r.channel, chatId: r.chatId }); setTab('chats'); }}>{t('inbox.openChat')}</button>
                  {/* a reschedule is not a new booking: the form here would create a second visit and leave the old one */}
                  {r.status === 'NEW' && bookingOn && r.patient && r.kind === 'BOOKING' && (
                    <button className="btn btn-sm" onClick={() => setBookingFor(bookingFor === r.id ? null : r.id)}>{t('book.open')}</button>
                  )}
                  {r.status === 'NEW' ? (
                    <>
                      {r.kind === 'BOOKING' || r.kind === 'RESCHEDULE' ? (
                        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setConfirmFor(confirmFor === r.id ? null : r.id)}>{t('inbox.reqMarkDone')}</button>
                      ) : (
                        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => closeReq(r.id, 'DONE')}>{t('inbox.reqMarkDone')}</button>
                      )}
                      <button className="btn btn-sm" disabled={busy} onClick={() => closeReq(r.id, 'DISMISSED')}>{t('inbox.reqDismiss')}</button>
                    </>
                  ) : (
                    <>
                      {r.confirmedAt && (r.noticeStatus === 'FAILED' || r.noticeStatus === 'SKIPPED') && (
                        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => retryNotice(r.id, false)}>{t('confirm.retry')}</button>
                      )}
                      {r.confirmedAt && r.noticeStatus === 'PENDING' && !!r.noticeAt && Date.now() - new Date(r.noticeAt).getTime() > 5 * 60_000 && (
                        <button className="btn btn-sm" disabled={busy} onClick={() => retryNotice(r.id, true)}>{t('confirm.retryForce')}</button>
                      )}
                      {!r.confirmedAt && <button className="btn btn-sm" disabled={busy} onClick={() => closeReq(r.id, 'NEW')}>{t('inbox.reqReopen')}</button>}
                    </>
                  )}
                </div>
                {confirmFor === r.id && (
                  <RequestConfirm
                    requestId={r.id}
                    initial={{ ...localParts(r.slotAt), service: r.service ?? '', doctor: r.doctor ?? '' }}
                    onCancel={() => setConfirmFor(null)}
                    onDone={() => { setConfirmFor(null); loadReqs(); window.dispatchEvent(new Event('stomat:requests-changed')); }}
                  />
                )}
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
            <>
            {channels.length > 1 && (
              <div className="toolbar" style={{ padding: '12px 16px 0' }} role="group" aria-label={t('inbox.channelFilter')}>
                <button className={chFilter === '' ? 'btn btn-sm btn-primary' : 'btn btn-sm'} aria-pressed={chFilter === ''} onClick={() => setChFilter('')}>{t('inbox.allChannels')}</button>
                {channels.map((ch) => (
                  <button key={ch} className={chFilter === ch ? 'btn btn-sm btn-primary' : 'btn btn-sm'} aria-pressed={chFilter === ch} onClick={() => setChFilter(ch)}>{chName(ch)}</button>
                ))}
              </div>
            )}
            <ul className="chat-list">
              {list.filter((c) => !chFilter || c.channel === chFilter).map((c) => (
                <li key={`${c.channel}:${c.chatId}`}>
                  <button className="chat-item" onClick={() => setOpen({ channel: c.channel, chatId: c.chatId })}>
                    <span className="chat-name">
                      <b>{name(c)}</b>
                      <Badge tone={c.channel === 'TELEGRAM' ? 'gray' : 'blue'}>{chName(c.channel)}</Badge>
                      {!c.patient && <Badge tone="amber">{t('inbox.notLinked')}</Badge>}
                      {c.answers && <Badge tone={c.answers === 'AI' ? 'teal' : 'gray'}>{c.answers === 'AI' ? t('inbox.answersAi') : t('inbox.answersStaff')}</Badge>}
                      {c.unread > 0 && <Badge tone="blue">{c.unread}</Badge>}
                    </span>
                    <span className="muted chat-last">{c.lastDirection === 'OUT' ? `${t('inbox.you')}: ` : ''}{c.lastText}</span>
                    <span className="muted chat-time">{fmtDateTime(c.lastAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
            </>
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
              {thread.dialogKey && (
                <details className="dialog-id">
                  <summary className="muted">{t('inbox.dialogId')}</summary>
                  <code className="dialog-key">{thread.dialogKey}</code>
                  <button className="btn btn-sm" type="button" onClick={() => { navigator.clipboard?.writeText(thread.dialogKey!).then(() => setCopied(true)).catch(() => undefined); }}>{copied ? t('inbox.dialogCopied') : t('inbox.dialogCopy')}</button>
                </details>
              )}
              {thread.optedOut && <Alert tone="warn">{t('inbox.optedOut')}</Alert>}
              {!thread.replyWindowOpen && <Alert tone="warn">{t('inbox.windowClosed', { channel: chName(open?.channel ?? '') })}</Alert>}
              {thread.agentOwnerHuman && !thread.botPausedUntil && (
                <Alert tone="info">
                  {t('inbox.agentHuman')}{' '}
                  <button className="btn btn-sm" disabled={busy} onClick={resumeBot}>{t('inbox.botResume')}</button>
                </Alert>
              )}
              {thread.botPausedUntil && (
                <Alert tone="info">
                  {t('inbox.botPaused', { time: new Date(thread.botPausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}{' '}
                  <button className="btn btn-sm" disabled={busy} onClick={resumeBot}>{t('inbox.botResume')}</button>
                </Alert>
              )}
              <div className="chat-thread" ref={threadRef} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
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
              {agentDraft && <AgentDraftPanel draft={agentDraft} busy={busy} note={agentNote} onApprove={approveAgent} onReject={rejectAgent} onRegenerate={['ask_data', 'ask_consent', 'create_visit', 'note'].includes(agentDraft.kind) ? refreshStep : makeDraft} onResolve={resolveAgent} onRecheck={recheckAgent} />}
              {!agentDraft && agentNote && <Alert tone={agentNote.tone}>{t(agentNote.key as TKey)}</Alert>}
              {!agentDraft && noticeRetry && (
                <div className="toolbar agent-draft-actions">
                  <button className="btn" disabled={busy} onClick={retryAgentNotice}>
                    {t('agent.result.noticeRetry')}
                  </button>
                </div>
              )}
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
              <p className="muted" style={{ fontSize: 13 }}>{t('inbox.sendNote', { channel: chName(open?.channel ?? '') })}{open && WINDOW_CHANNELS.has(open.channel) ? ` ${t('inbox.sendNoteWindow')}` : ''}</p>
            </>
          )}
        </Card>
      )}
    </>
  );
}
