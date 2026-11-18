'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { fmtDateTime } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';
import { useConfirm } from '../../../components/ConfirmDialog';
import { CampaignsCard } from '../../../components/CampaignsCard';
import { AutoMessagesSettings } from '../../../components/AutoMessagesSettings';
import { CustomAutomations } from '../../../components/CustomAutomations';
import { ReviewLinkCard } from '../../../components/ReviewLinkCard';

interface Overview {
  settings: { autoSendService: boolean; sendingEnabled: boolean; assumeConsent: boolean };
  queue: Record<string, number>;
}
interface Msg {
  id: string;
  patient: { id: string; fullName: string };
  ruleKey: string;
  campaignName?: string | null;
  channel: string;
  text: string;
  status: string;
  scheduledFor: string;
  sentAt: string | null;
  error: string | null;
  // a failure that certainly did not reach the patient: staff may send it again
  retryable?: boolean;
}
interface MsgList {
  total: number;
  page: number;
  pageSize: number;
  counts: Record<string, number>;
  rows: Msg[];
}

const TONE: Record<string, 'gray' | 'amber' | 'blue' | 'green' | 'red'> = {
  PENDING_APPROVAL: 'amber',
  APPROVED: 'blue',
  SENT: 'green',
  FAILED: 'red',
  CANCELLED: 'gray',
  EXPIRED: 'gray',
  UNKNOWN: 'amber',
};
// The views of the daily workspace over the queue's own statuses (no new states):
//   approval  — PENDING_APPROVAL: waits for a person; never shown as ready to send;
//   scheduled — APPROVED: approved (or allowed to go by itself) and waiting for its time and the sending hours;
//   history   — what happened: SENT (handed to the channel, not a delivery receipt), UNKNOWN (no clear answer: never retried), FAILED, CANCELLED, EXPIRED.
const VIEWS = { approval: ['PENDING_APPROVAL'], scheduled: ['APPROVED'], history: ['SENT', 'UNKNOWN', 'FAILED', 'CANCELLED', 'EXPIRED'] } as const;
type View = keyof typeof VIEWS | 'campaigns' | 'rules';
type QueueView = keyof typeof VIEWS;
const isQueue = (v: View): v is QueueView => v in VIEWS;
// rules: what is sent by itself and when (the ready rules, then the clinic's own); only the owner and the manager set them up
const ALL: View[] = ['approval', 'scheduled', 'history', 'campaigns', 'rules'];

// "Reminders and campaigns": everything the clinic sends first. The queue (to approve, scheduled, history), one-time campaigns and the rules of automatic
// messages are here together; channels are connected in Settings.
export default function MessagesPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [view, setView] = useState<View>('approval');
  const [status, setStatus] = useState<string>('PENDING_APPROVAL');
  const [msgs, setMsgs] = useState<MsgList | null>(null);
  const [page, setPage] = useState(1);
  // the history's channel filter ('' = all)
  const [channel, setChannel] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const [role, setRole] = useState('');
  useEffect(() => {
    api<{ role: string }>('/auth/me').then((m) => setRole(m.role)).catch(() => undefined);
  }, []);
  const ORDER = ALL.filter((v) => v !== 'rules' || role === 'OWNER' || role === 'MANAGER');
  const { ask, dialog } = useConfirm();

  // The Facebook and Instagram logins return here (/automations?meta=… / ?ig=…): their channels are in Settings now, the parameters go along
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.has('meta') || q.has('ig')) {
      setMoving(true);
      q.set('tab', 'channels');
      router.replace(`/settings?${q}`);
      return;
    }
    const v = q.get('view');
    if (v && (ALL as string[]).includes(v)) {
      setView(v as View);
      if (isQueue(v as View)) setStatus(VIEWS[v as QueueView][0]);
    }
  }, [router]);

  const loadOverview = useCallback(() => {
    api<Overview>('/automations').then(setData).catch((e) => setError((e as Error).message));
  }, []);
  const loadMsgs = useCallback(() => {
    if (!isQueue(view)) return;
    setMsgs(null);
    api<MsgList>(`/messages?status=${status}&page=${page}${channel ? `&channel=${channel}` : ''}`).then(setMsgs).catch((e) => setError((e as Error).message));
  }, [status, page, view, channel]);
  useEffect(loadOverview, [loadOverview]);
  useEffect(loadMsgs, [loadMsgs]);
  useEffect(() => {
    if (!info) return;
    const id = setTimeout(() => setInfo(''), 6000);
    return () => clearTimeout(id);
  }, [info]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
      loadOverview();
      loadMsgs();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = (v: View) => {
    setView(v);
    setPage(1);
    if (isQueue(v)) setStatus(VIEWS[v][0]);
    const q = new URLSearchParams(window.location.search);
    if (v === 'approval') q.delete('view');
    else q.set('view', v);
    window.history.replaceState(null, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}`);
  };
  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const i = ORDER.indexOf(view);
    const next = e.key === 'ArrowRight' ? ORDER[(i + 1) % ORDER.length] : e.key === 'ArrowLeft' ? ORDER[(i - 1 + ORDER.length) % ORDER.length] : e.key === 'Home' ? ORDER[0] : e.key === 'End' ? ORDER[ORDER.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    pick(next);
    document.getElementById(`msg-tab-${next}`)?.focus();
  };

  if (moving) return <Loading />;
  if (!data) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  // a role without the rules tab that opened its address sees the first tab
  const shown: View = role && !ORDER.includes(view) ? 'approval' : view;
  const count = (v: keyof typeof VIEWS) => VIEWS[v].reduce((n, s) => n + (data.queue[s] ?? 0), 0);
  const pending = data.queue.PENDING_APPROVAL ?? 0;

  return (
    <>
      {dialog}
      <PageHeader title={t('msgw.title')} subtitle={t('msgw.subtitle')} />
      {!data.settings.sendingEnabled && (
        <Alert tone="warn">
          {t('msgw.sendingOff')} <Link href="/settings">{t('msgw.toSettings')}</Link>
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      <div className="tabs" role="tablist" aria-label={t('msgw.title')}>
        {ORDER.map((v) => (
          <button key={v} id={`msg-tab-${v}`} type="button" role="tab" aria-selected={shown === v} aria-controls="msg-panel" tabIndex={shown === v ? 0 : -1} className={`tab${shown === v ? ' active' : ''}`} onClick={() => pick(v)} onKeyDown={onTabKey}>
            {t(`msgw.tab.${v}`)}
            {isQueue(v) && v !== 'history' && count(v) > 0 ? ` · ${count(v)}` : ''}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="msg-panel" aria-labelledby={`msg-tab-${shown}`}>
        {shown === 'rules' ? (
          <>
            <p className="rule" style={{ marginTop: 0 }}>{t('msgw.rulesIntro')}</p>
            <AutoMessagesSettings onOpenGeneral={() => router.push('/settings')} />
            <ReviewLinkCard />
            <CustomAutomations />
          </>
        ) : shown === 'campaigns' ? (
          <>
            <p className="rule" style={{ marginTop: 0 }}>{t('camp.tabIntro')} {t('camp.onlyTelegram')}</p>
            <CampaignsCard onChanged={() => { loadOverview(); }} />
          </>
        ) : (
          <Card
            flush
            title={t(`msgw.tab.${shown}`)}
            actions={
              shown === 'approval' && pending > 0 ? (
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={async () => (await ask(t('au.approveConfirm', { n: pending }), { confirmLabel: t('au.approveAll', { n: pending }) })) && act(() => api('/messages/approve', { method: 'POST', body: JSON.stringify({ all: true }) }), t('au.approved'))}>
                  {t('au.approveAll', { n: pending })}
                </button>
              ) : undefined
            }
          >
            <p className="rule" style={{ padding: '0 20px' }}>{t(`msgw.about.${shown}`)}</p>
            {shown === 'history' && <p className="muted" style={{ padding: '0 20px', fontSize: 13 }}>{t('msgw.sentNote')}</p>}
            {shown === 'history' && (
              <div className="toolbar" role="group" aria-label={t('msgw.tab.history')} style={{ padding: '0 20px 12px' }}>
                {VIEWS.history.map((s) => (
                  <button key={s} className={`btn btn-sm${status === s ? ' btn-primary' : ''}`} aria-pressed={status === s} onClick={() => { setStatus(s); setPage(1); }}>
                    {t(`au.st.${s}` as never)} · {data.queue[s] ?? 0}
                  </button>
                ))}
                <label className="field" style={{ margin: 0 }}>
                  <span className="sr-only">{t('msgw.colChannel')}</span>
                  <select className="input" value={channel} onChange={(e) => { setChannel(e.target.value); setPage(1); }}>
                    <option value="">{t('msgw.allChannels')}</option>
                    <option value="TELEGRAM">Telegram</option>
                    <option value="INSTAGRAM">Instagram</option>
                  </select>
                </label>
              </div>
            )}
            {!msgs ? (
              <Loading />
            ) : !msgs.rows.length ? (
              <Empty title={t(`msgw.empty.${shown === 'history' ? status : shown}` as never)}>{t(`msgw.emptyHint.${shown}`)}</Empty>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('au.colPatient')}</th>
                        <th>{t('au.colText')}</th>
                        <th>{t('msgw.colChannel')}</th>
                        <th>{t('au.colStatus')}</th>
                        <th>{shown === 'history' ? t('msgw.colWhenDone') : t('msgw.colWhenPlanned')}</th>
                        <th>{t('au.colActions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {msgs.rows.map((m) => (
                        <tr key={m.id}>
                          <td>
                            <Link href={`/patients/${m.patient.id}`} className="cell-main">{m.patient.fullName}</Link>
                            <div className="cell-sub">{m.ruleKey.startsWith('campaign:') ? `${t('camp.label')}: ${m.campaignName ?? ''}` : t(`au.r.${m.ruleKey}` as never)}</div>
                          </td>
                          <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{m.text}</td>
                          <td>{m.channel === 'INSTAGRAM' ? 'Instagram' : m.channel === 'TELEGRAM' ? 'Telegram' : m.channel}</td>
                          <td>
                            <Badge tone={TONE[m.status] ?? 'gray'}>{t(`msgw.st.${m.status}` as never)}</Badge>
                            {m.error && <div className="cell-sub">{m.error}</div>}
                          </td>
                          <td>{fmtDateTime(shown === 'history' ? (m.sentAt ?? m.scheduledFor) : m.scheduledFor)}</td>
                          <td>
                            <div className="toolbar" style={{ flexWrap: 'nowrap' }}>
                              {m.status === 'PENDING_APPROVAL' && (
                                <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api('/messages/approve', { method: 'POST', body: JSON.stringify({ ids: [m.id] }) }))}>{t('au.approve')}</button>
                              )}
                              {m.retryable && (
                                <button
                                  className="btn btn-sm"
                                  disabled={busy}
                                  onClick={async () => {
                                    if (!(await ask(t('msgw.retryConfirm'), { title: t('msgw.retry'), confirmLabel: t('msgw.retry') }))) return;
                                    act(() => api(`/messages/${m.id}/retry`, { method: 'POST' }), t('msgw.retried'));
                                  }}
                                >
                                  {t('msgw.retry')}
                                </button>
                              )}
                              {(m.status === 'PENDING_APPROVAL' || m.status === 'APPROVED') && (
                                <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api('/messages/cancel', { method: 'POST', body: JSON.stringify({ ids: [m.id] }) }))}>{t('au.cancel')}</button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {msgs.total > msgs.pageSize && (
                  <div className="toolbar" style={{ padding: '12px 20px', justifyContent: 'space-between' }}>
                    <span className="muted">{t('pat.page', { page: msgs.page, pages: Math.ceil(msgs.total / msgs.pageSize) })}</span>
                    <span className="toolbar">
                      <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t('common.back')}</button>
                      <button className="btn btn-sm" disabled={page >= Math.ceil(msgs.total / msgs.pageSize)} onClick={() => setPage((p) => p + 1)}>{t('common.forward')}</button>
                    </span>
                  </div>
                )}
              </>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
