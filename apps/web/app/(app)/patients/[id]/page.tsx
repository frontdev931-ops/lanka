'use client';

import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '../../../../lib/api';
import { Key, useI18n } from '../../../../lib/i18n';
import { fmtAmount, fmtDate, fmtDateTime, initials } from '../../../../lib/ui';
import { Alert, Badge, Card, Empty, Icon, Loading, resultTone, statusTone } from '../../../../components/ui';
import { LineTabs } from '../../../../components/LineTabs';
import { QrCode } from '../../../../components/QrCode';

// The patient card (2026-11-24): a compact summary with the nearest visit on top, the details in tabs that load when opened. Everything marked
// "Cliniccards" is read from the clinic's Cliniccards (read only); "LANKA" is what LANKA itself recorded, linked to this card by an identifier.
// The server leaves out what the role may not see (the doctor gets no money; chats and requests only for the roles of Messages).

type Visit = { id: string; startsAt: string; endsAt?: string | null; status: string; doctorName: string | null; serviceName: string | null; amount?: string | null };
interface Patient {
  id: string;
  fullName: string;
  phone: string | null;
  phone2: string | null;
  email: string | null;
  gender: string | null;
  tags: string[];
  subclinic: string | null;
  curator: string | null;
  birthDate: string | null;
  age: number | null;
  source: string | null;
  preferredContact: string | null;
  createdAtExt: string | null;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  removedAt?: string | null;
  balanceIssued?: string | null;
  balancePaid?: string | null;
  balanceCurrency?: string | null;
  consent: 'UNKNOWN' | 'GIVEN' | 'WITHDRAWN';
  consentNote: string | null;
  automationPaused: boolean;
  extra: Record<string, { v: string; b: string }>;
  channels?: { channel: string; username: string | null; optedOutAt: string | null }[];
  outbox?: { id: string; ruleKey: string; status: string; text: string; scheduledFor: string; sentAt: string | null; error: string | null }[];
  visits: Visit[];
  tasks: { id: string; title: string; status: string; result: string | null; dueDate: string; assignee: { name: string } | null }[];
  contacts: { id: string; channel: string; outcome: string | null; note: string | null; source: string; contactedAt: string; user: { name: string } | null }[];
  nextVisit: { startsAt: string; endsAt: string | null; status: string; doctorName: string | null; serviceName: string | null } | null;
  lastSyncAt: string | null;
  counts: { visits: number; plan: number; finance?: number; requests?: number; chats?: number; inquiries?: number };
  access: { money: boolean; chats: boolean; lanka: boolean; write: boolean };
}
type Tab = 'overview' | 'visits' | 'treatment' | 'finance' | 'lanka';

const CHANNELS = ['PHONE', 'MESSENGER', 'SMS', 'EMAIL', 'VISIT', 'OTHER'];
const OUTCOMES = ['BOOKED', 'CALL_LATER', 'NO_ANSWER', 'DECLINED'];
const CH: Record<string, string> = { TELEGRAM: 'Telegram', INSTAGRAM: 'Instagram', MESSENGER: 'Messenger', WHATSAPP: 'WhatsApp', VIBER: 'Viber', WEB: 'Web' };

// One tab's data: loaded the first time the tab opens; "not loaded yet", "loading", "error" and "empty" are told apart
function useLazy<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!url) return;
    setBusy(true);
    setError('');
    api<T>(url)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, [url]);
  return { data, setData, error, busy, load };
}

function Loadable({ error, busy, ready, onRetry, children }: { error: string; busy: boolean; ready: boolean; onRetry: () => void; children: ReactNode }) {
  const { t } = useI18n();
  if (error) return <Alert tone="error">{t('pc.loadError')} <button className="btn btn-sm" onClick={onRetry}>{t('pc.retry')}</button></Alert>;
  if (!ready || busy) return <Loading />;
  return <>{children}</>;
}

// A label with its source: what comes from Cliniccards and what LANKA recorded itself
const Source = ({ kind }: { kind: 'cc' | 'lanka' }) => <span className={`pc-src pc-src-${kind}`}>{kind === 'cc' ? 'Cliniccards' : 'LANKA'}</span>;

export default function PatientPage() {
  const { id } = useParams<{ id: string }>();
  const { t, label } = useI18n();
  const [p, setP] = useState<Patient | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const load = useCallback(() => api<Patient>(`/patients/${id}`).then(setP).catch((e) => setError((e as Error).message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !p) return <Alert tone="error">{error}</Alert>;
  if (!p) return <Loading />;

  const amt = (n: number | string, cur: string | null) => fmtAmount(n, cur, t('billing.uah'), t('money.unknownShort'));
  const issued = Number(p.balanceIssued ?? 0);
  const paid = Number(p.balancePaid ?? 0);
  const debt = p.access.money && issued - paid > 0 ? amt(Math.round((issued - paid) * 100) / 100, p.balanceCurrency ?? null) : null;
  // every role keeps the LANKA tab (contacts and tasks, as before); chats, requests and inquiries inside it follow the role
  const tabs: Tab[] = ['overview', 'visits', 'treatment', ...(p.access.money ? (['finance'] as Tab[]) : []), 'lanka'];
  const count = (k: Tab) => (k === 'visits' ? p.counts.visits : k === 'treatment' ? p.counts.plan : k === 'finance' ? p.counts.finance : undefined);
  const gender = p.gender ? (/^(m|male|ч)/i.test(p.gender) ? t('pc.male') : /^(f|female|ж)/i.test(p.gender) ? t('pc.female') : p.gender) : null;
  const nv = p.nextVisit;

  return (
    <>
      <p style={{ marginTop: 0 }}>
        <Link href="/patients"><Icon name="back" size={14} /> {t('pd.all')}</Link>
      </p>
      {p.removedAt && <Alert tone="warn">{t('pd.removed')}</Alert>}

      <section className="card pc-head">
        <div className="pc-who">
          <span className="avatar lg" aria-hidden="true">{initials(p.fullName)}</span>
          <div style={{ minWidth: 0 }}>
            <h1 className="pc-name">{p.fullName}</h1>
            <div className="pc-meta">
              {p.age !== null && <span>{t('pc.age', { n: p.age })}{p.birthDate ? ` · ${fmtDate(p.birthDate)}` : ''}</span>}
              {gender && <span>{gender}</span>}
              {p.subclinic && <span>{p.subclinic}</span>}
            </div>
            <div className="pc-contacts">
              {p.phone ? <a href={`tel:+${p.phone.replace(/\D/g, '')}`}>{p.phone}</a> : <span className="muted">{t('pd.noPhone')}</span>}
              {p.phone2 && <a href={`tel:+${p.phone2.replace(/\D/g, '')}`}>{p.phone2}</a>}
              {p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}
            </div>
            <div className="toolbar" style={{ marginTop: 8, gap: 6 }}>
              {p.tags.map((tag) => <Badge key={tag} tone="blue">{tag}</Badge>)}
              {debt && <Badge tone="amber">{t('pc.debt', { sum: debt })}</Badge>}
              {/* the consent to messages only when it says something (given or withdrawn); "unknown" is the default of every card */}
              {p.consent !== 'UNKNOWN' && <Badge tone={p.consent === 'GIVEN' ? 'green' : 'red'}>{label('consent', p.consent)}</Badge>}
              {p.automationPaused && <Badge tone="amber">{t('pd.automationPaused')}</Badge>}
            </div>
          </div>
        </div>
        <div className={`pc-next${nv ? '' : ' none'}`}>
          <span className="pc-next-label">{t('pc.next')}</span>
          {nv ? (
            <>
              <b>{fmtDateTime(nv.startsAt)}</b>
              <span>{[nv.doctorName, nv.serviceName].filter(Boolean).join(' · ')}</span>
              <span><Badge tone={statusTone(nv.status)}>{label('status', nv.status)}</Badge></span>
            </>
          ) : (
            <span className="muted">{t('pc.noNext')}</span>
          )}
        </div>
        <p className="pc-sync">
          <Source kind="cc" /> {p.lastSyncAt ? t('pc.synced', { date: fmtDateTime(p.lastSyncAt) }) : t('pc.neverSynced')}
        </p>
      </section>

      <LineTabs id="pc" label={t('pc.tabs')} tabs={tabs} active={tab} onPick={setTab} render={(k) => <>{t(`pc.tab.${k}` as Key)}{count(k) ? <span className="pc-count">{count(k)}</span> : null}</>} />
      <div role="tabpanel" id={`pc-panel-${tab}`} aria-labelledby={`pc-tab-${tab}`}>
        {tab === 'overview' && <Overview p={p} gender={gender} onMore={() => setTab('visits')} />}
        {tab === 'visits' && <Visits id={p.id} money={p.access.money} />}
        {tab === 'treatment' && <Treatment id={p.id} money={p.access.money} />}
        {tab === 'finance' && <Finance id={p.id} />}
        {tab === 'lanka' && <Lanka p={p} reload={load} />}
      </div>
    </>
  );
}

function Overview({ p, gender, onMore }: { p: Patient; gender: string | null; onMore: () => void }) {
  const { t } = useI18n();
  // only the fields that have a value
  const rows: [string, ReactNode][] = (
    [
      [t('pd.source'), p.source],
      [t('pd.contact'), p.preferredContact],
      [t('pc.curator'), p.curator],
      [t('pc.created'), p.createdAtExt ? fmtDate(p.createdAtExt) : null],
      [t('pc.firstVisit'), p.firstVisitAt ? fmtDate(p.firstVisitAt) : null],
      [t('pd.lastVisit'), p.lastVisitAt ? fmtDate(p.lastVisitAt) : null],
      [t('pc.gender'), gender],
    ] as [string, ReactNode][]
  ).filter(([, v]) => v !== null && v !== undefined && v !== '');
  const extra = Object.entries(p.extra ?? {});
  return (
    <>
      <Card title={t('pc.cardTitle')} actions={<Source kind="cc" />}>
        {rows.length ? (
          <dl className="info-grid" style={{ marginTop: 0 }}>
            {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        ) : (
          <p className="muted" style={{ margin: 0 }}>{t('pc.noCardFields')}</p>
        )}
        <p className="rule" style={{ margin: '12px 0 0' }}>{t('pc.notRead')}</p>
      </Card>
      <Card title={t('pc.recent')} actions={<Source kind="cc" />}>
        {p.visits.length ? (
          <>
            <VisitList rows={p.visits} money={p.access.money} />
            {p.counts.visits > p.visits.length && <button className="btn btn-sm" onClick={onMore}>{t('pc.allVisits', { n: p.counts.visits })}</button>}
          </>
        ) : (
          <Empty title={t('pd.noVisits')} />
        )}
      </Card>
      {extra.length > 0 && (
        <Card title={t('pd.extra')} actions={<Source kind="lanka" />}>
          <p className="rule">{t('pd.extraHint')}</p>
          <dl className="kv">{extra.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v.v}</dd></div>)}</dl>
        </Card>
      )}
    </>
  );
}

function VisitList({ rows, money }: { rows: Visit[]; money: boolean }) {
  const { t, label } = useI18n();
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>{t('pd.colDate')}</th><th>{t('pd.colStatus')}</th><th>{t('pd.colDoctor')}</th><th>{t('pd.colServices')}</th>{money && <th className="num">{t('pd.colAmount')}</th>}</tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.id}>
              <td>{fmtDateTime(v.startsAt)}</td>
              <td><Badge tone={statusTone(v.status)}>{label('status', v.status)}</Badge></td>
              <td>{v.doctorName ?? <span className="muted">—</span>}</td>
              <td>{v.serviceName ?? <span className="muted">—</span>}</td>
              {money && <td className="num">{v.amount ? Number(v.amount).toLocaleString() : <span className="muted">—</span>}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Paged<T> { total: number; page: number; pageSize: number; rows: T[] }

function Visits({ id, money }: { id: string; money: boolean }) {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const q = useLazy<Paged<Visit>>(`/patients/${id}/visits?page=1`);
  const [rows, setRows] = useState<Visit[]>([]);
  const [more, setMore] = useState({ busy: false, error: '' });
  useEffect(q.load, [q.load]);
  useEffect(() => {
    if (q.data) setRows(q.data.rows);
  }, [q.data]);
  const next = async () => {
    setMore({ busy: true, error: '' });
    try {
      const r = await api<Paged<Visit>>(`/patients/${id}/visits?page=${page + 1}`);
      setRows((x) => [...x, ...r.rows]);
      setPage(page + 1);
      setMore({ busy: false, error: '' });
    } catch (e) {
      setMore({ busy: false, error: (e as Error).message });
    }
  };
  return (
    <Card title={t('pc.tab.visits')} actions={<Source kind="cc" />}>
      <Loadable error={q.error} busy={q.busy && !q.data} ready={!!q.data} onRetry={q.load}>
        {rows.length ? (
          <>
            <VisitList rows={rows} money={money} />
            <MoreButton shown={rows.length} total={q.data?.total ?? 0} busy={more.busy} error={more.error} onMore={next} />
          </>
        ) : (
          <Empty title={t('pd.noVisits')} />
        )}
      </Loadable>
    </Card>
  );
}

function MoreButton({ shown, total, busy, error, onMore }: { shown: number; total: number; busy: boolean; error: string; onMore: () => void }) {
  const { t } = useI18n();
  return (
    <div className="toolbar" style={{ marginTop: 10 }}>
      <span className="muted" style={{ fontSize: 13 }}>{t('pc.shown', { n: shown, total })}</span>
      {shown < total && <button className="btn btn-sm" disabled={busy} onClick={onMore}>{busy ? t('pc.loading') : t('pc.more')}</button>}
      {error && <span className="sig-msg err">{t('pc.loadError')}</span>}
    </div>
  );
}

interface TreatmentView {
  plans: { planId: string; createdAt: string | null; total?: string; totalDone?: string; currency?: string | null; items: { id: string; name: string; groupName: string | null; status: string; createdAt: string; doneAt: string | null; doctor: string | null; price?: string | null }[] }[];
  truncated: boolean;
}

function Treatment({ id, money }: { id: string; money: boolean }) {
  const { t } = useI18n();
  const q = useLazy<TreatmentView>(`/patients/${id}/treatment`);
  useEffect(q.load, [q.load]);
  const amt = (n: number | string, cur: string | null | undefined) => fmtAmount(n, cur ?? null, t('billing.uah'), t('money.unknownShort'));
  const tone = (s: string) => (s === 'DONE' || s === 'INVOICED' ? 'green' : s === 'PLANNED_TO_DO' ? 'blue' : 'gray');
  return (
    <Loadable error={q.error} busy={q.busy && !q.data} ready={!!q.data} onRetry={q.load}>
      {q.data && !q.data.plans.length && <Card><Empty title={t('pc.noPlans')} /></Card>}
      {q.data?.plans.map((pl) => {
        const done = pl.items.filter((i) => i.status === 'DONE' || i.status === 'INVOICED').length;
        return (
          <Card key={pl.planId} title={pl.createdAt ? t('pc.planFrom', { date: fmtDate(pl.createdAt) }) : t('pc.plan')} actions={<Source kind="cc" />}>
            <p className="rule" style={{ marginTop: 0 }}>
              {t('pc.planDone', { done, n: pl.items.length })}
              {money && pl.total !== undefined && ` · ${t('pc.planSum', { done: amt(pl.totalDone ?? 0, pl.currency), total: amt(pl.total, pl.currency) })}`}
            </p>
            <ul className="list">
              {pl.items.map((i) => (
                <li key={i.id}>
                  <span style={{ minWidth: 0 }}>
                    <span className="cell-main">{i.name}</span>
                    <div className="cell-sub">{[i.groupName, i.doctor, i.doneAt ? t('pc.doneAt', { date: fmtDate(i.doneAt) }) : null].filter(Boolean).join(' · ')}</div>
                  </span>
                  <span className="toolbar">
                    {money && i.price && Number(i.price) > 0 && <span className="muted" style={{ fontSize: 13 }}>{Number(i.price).toLocaleString()}</span>}
                    <Badge tone={tone(i.status)}>{t(`pc.ps.${i.status}` as Key)}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
      {q.data?.truncated && <p className="muted" style={{ fontSize: 13 }}>{t('pc.truncated')}</p>}
    </Loadable>
  );
}

interface FinanceRow { id: string; kind: 'invoice' | 'payment'; date: string; amount: string; currency: string; by: string | null }
interface FinanceView extends Paged<FinanceRow> { balance: { issued: number; paid: number; debt: number; currency: string | null } | null }

function Finance({ id }: { id: string }) {
  const { t } = useI18n();
  const q = useLazy<FinanceView>(`/patients/${id}/finance?page=1`);
  const [rows, setRows] = useState<FinanceRow[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState({ busy: false, error: '' });
  useEffect(q.load, [q.load]);
  useEffect(() => {
    if (q.data) setRows(q.data.rows);
  }, [q.data]);
  const amt = (n: number | string, cur: string | null) => fmtAmount(n, cur, t('billing.uah'), t('money.unknownShort'));
  const next = async () => {
    setMore({ busy: true, error: '' });
    try {
      const r = await api<FinanceView>(`/patients/${id}/finance?page=${page + 1}`);
      setRows((x) => [...x, ...r.rows]);
      setPage(page + 1);
      setMore({ busy: false, error: '' });
    } catch (e) {
      setMore({ busy: false, error: (e as Error).message });
    }
  };
  const b = q.data?.balance;
  return (
    <Loadable error={q.error} busy={q.busy && !q.data} ready={!!q.data} onRetry={q.load}>
      <Card title={t('pc.balance')} actions={<Source kind="cc" />}>
        {b ? (
          <div className="stats" style={{ marginBottom: 0 }}>
            <div className="pc-stat"><span>{t('pd.billed')}</span><b>{amt(b.issued, b.currency)}</b></div>
            <div className="pc-stat"><span>{t('pd.paid')}</span><b>{amt(b.paid, b.currency)}</b></div>
            <div className={`pc-stat${b.debt > 0 ? ' warn' : ''}`}><span>{t('pd.debt')}</span><b>{amt(b.debt, b.currency)}</b></div>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>{t('pc.noBalance')}</p>
        )}
        <p className="rule" style={{ margin: '12px 0 0' }}>{t('pc.balanceRule')}</p>
      </Card>
      <Card title={t('pc.operations')} actions={<Source kind="cc" />}>
        {rows.length ? (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t('pd.colDate')}</th><th>{t('pc.colKind')}</th><th>{t('pc.colBy')}</th><th className="num">{t('pd.colAmount')}</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.kind}-${r.id}`}>
                      <td>{fmtDate(r.date)}</td>
                      <td><Badge tone={r.kind === 'payment' ? 'green' : 'blue'}>{r.kind === 'payment' ? t('pc.payment') : t('pc.invoice')}</Badge></td>
                      <td>{r.by ?? <span className="muted">—</span>}</td>
                      <td className="num">{amt(r.amount, r.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <MoreButton shown={rows.length} total={q.data?.total ?? 0} busy={more.busy} error={more.error} onMore={next} />
          </>
        ) : (
          <Empty title={t('pc.noOperations')} />
        )}
      </Card>
    </Loadable>
  );
}

interface LankaView {
  access: { chats: boolean };
  conversations: { channel: string; chatId: string; username: string | null; linkedAt: string; optedOutAt: string | null; lastAt: string | null; lastIn: boolean | null }[];
  requests: { id: string; kind: string; status: string; summary: string; channel: string; createdAt: string }[];
  inquiries: { id: string; channel: string; occurredAt: string; status: string }[];
  reviews: { id: string; rating: number; createdAt: string }[];
}

// What LANKA recorded itself: chats, requests, inquiries and ratings tied to this card by an identifier, and the staff's own work with the patient
function Lanka({ p, reload }: { p: Patient; reload: () => void }) {
  const { t, label } = useI18n();
  const q = useLazy<LankaView>(p.access.lanka ? `/patients/${p.id}/lanka` : null);
  useEffect(q.load, [q.load]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [tgLink, setTgLink] = useState('');
  const [consent, setConsent] = useState<Patient['consent']>(p.consent);
  const [consentNote, setConsentNote] = useState(p.consentNote ?? '');
  const [paused, setPaused] = useState(p.automationPaused);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  async function addTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    await run(async () => { await api('/tasks', { method: 'POST', body: JSON.stringify({ title: f.title, patientId: p.id, dueDate: f.dueDate || undefined }) }); form.reset(); });
  }
  async function addContact(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    await run(async () => { await api(`/patients/${p.id}/contacts`, { method: 'POST', body: JSON.stringify({ channel: f.channel, outcome: f.outcome || undefined, note: f.note || undefined }) }); form.reset(); });
  }
  const tg = p.channels?.find((c) => c.channel === 'TELEGRAM');
  const v = q.data;

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      {p.access.lanka && (
        <Card title={t('pc.conversations')} actions={<Source kind="lanka" />}>
          <Loadable error={q.error} busy={q.busy && !v} ready={!!v} onRetry={q.load}>
            {v && (
              <>
                {v.access.chats && (
                  <>
                    <h3 className="pc-sub">{t('pc.chats')}</h3>
                    {v.conversations.length ? (
                      <ul className="list">
                        {v.conversations.map((c) => (
                          <li key={`${c.channel}-${c.chatId}`}>
                            <span>
                              <span className="cell-main">{CH[c.channel] ?? c.channel}{c.username ? ` · @${c.username}` : ''}</span>
                              <div className="cell-sub">{c.lastAt ? t(c.lastIn ? 'pc.lastIn' : 'pc.lastOut', { date: fmtDateTime(c.lastAt) }) : t('pc.noMessages')}{c.optedOutAt ? ` · ${t('pd.tgOff')}` : ''}</div>
                            </span>
                            <Link className="btn btn-sm" href={`/inbox?channel=${encodeURIComponent(c.channel)}&chat=${encodeURIComponent(c.chatId)}`}>{t('pc.openChat')}</Link>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">{t('pc.noChats')}</p>
                    )}
                    <h3 className="pc-sub">{t('pc.requests')}</h3>
                    {v.requests.length ? (
                      <ul className="list">
                        {v.requests.map((r) => (
                          <li key={r.id}>
                            <span style={{ minWidth: 0 }}>
                              <span className="cell-main">{r.summary}</span>
                              <div className="cell-sub">{fmtDateTime(r.createdAt)} · {CH[r.channel] ?? r.channel}</div>
                            </span>
                            <Badge tone={r.status === 'NEW' ? 'amber' : r.status === 'DONE' ? 'green' : 'gray'}>{t(`pc.rq.${r.status}` as Key)}</Badge>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">{t('pc.noRequests')}</p>
                    )}
                  </>
                )}
                <h3 className="pc-sub">{t('pc.inquiries')}</h3>
                {v.inquiries.length ? (
                  <ul className="list">
                    {v.inquiries.map((r) => (
                      <li key={r.id}>
                        <span className="cell-main">{label('channel', r.channel)}</span>
                        <span className="muted" style={{ fontSize: 13 }}>{fmtDateTime(r.occurredAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{t('pc.noInquiries')}</p>
                )}
                {v.reviews.length > 0 && (
                  <>
                    <h3 className="pc-sub">{t('pc.reviews')}</h3>
                    <p style={{ margin: 0 }}>{v.reviews.map((r) => `${r.rating}/5 (${fmtDate(r.createdAt)})`).join(' · ')}</p>
                  </>
                )}
              </>
            )}
          </Loadable>
        </Card>
      )}

      <Card title={t('pd.contacts')} actions={<Source kind="lanka" />}>
          {p.access.write && (
          <form onSubmit={addContact} className="toolbar" style={{ marginBottom: 8 }}>
            <select className="select" name="channel" defaultValue="PHONE" aria-label={t('pd.channel')}>
              {CHANNELS.map((c) => <option key={c} value={c}>{label('channel', c)}</option>)}
            </select>
            <select className="select" name="outcome" defaultValue="" aria-label={t('pd.outcome')}>
              <option value="">{t('pd.noOutcome')}</option>
              {OUTCOMES.map((o) => <option key={o} value={o}>{label('result', o)}</option>)}
            </select>
            <input className="input grow" name="note" maxLength={1000} placeholder={t('pd.note')} aria-label={t('pd.note')} />
            <button type="submit" className="btn btn-primary"><Icon name="plus" size={16} /> {t('pd.addContact')}</button>
          </form>
          )}
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

      <Card title={t('pd.tasks')} actions={<Source kind="lanka" />}>
        {p.access.write && (
          <form onSubmit={addTask} className="toolbar" style={{ marginBottom: 8 }}>
            <input className="input grow" name="title" placeholder={t('pd.newTask')} required minLength={2} aria-label={t('pd.newTask')} />
            <input className="input" name="dueDate" type="date" aria-label={t('pc.due')} />
            <button type="submit" className="btn btn-primary"><Icon name="plus" size={16} /> {t('common.add')}</button>
          </form>
        )}
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

      {p.access.write && (
        <Card title={t('pd.consent')} actions={<Source kind="lanka" />}>
          <p className="rule">{t('pd.consentHint')}</p>
          <div className="form-grid">
            <div className="field">
              <select className="select" value={consent} onChange={(e) => setConsent(e.target.value as Patient['consent'])} aria-label={t('pd.consent')}>
                {['UNKNOWN', 'GIVEN', 'WITHDRAWN'].map((c) => <option key={c} value={c}>{label('consent', c)}</option>)}
              </select>
            </div>
            <div className="field">
              <input className="input" value={consentNote} maxLength={500} placeholder={t('pd.consentNote')} aria-label={t('pd.consentNote')} onChange={(e) => setConsentNote(e.target.value)} />
            </div>
          </div>
          <div className="toolbar">
            <label className="checkbox"><input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} /> {t('pd.automationPaused')}</label>
            <button className="btn btn-primary" onClick={() => void run(() => api(`/patients/${p.id}/consent`, { method: 'PATCH', body: JSON.stringify({ consent, note: consentNote, automationPaused: paused }) }), t('common.saved'))}>{t('common.save')}</button>
          </div>
        </Card>
      )}

      {p.access.write && (
        <Card title={t('pd.msgTitle')} actions={<Source kind="lanka" />}>
          <p className="rule">
            {tg && !tg.optedOutAt ? <Badge tone="green">{t('pd.tgOn')}{tg.username ? ` @${tg.username}` : ''}</Badge> : tg ? <Badge tone="red">{t('pd.tgOff')}</Badge> : <Badge tone="gray">{t('pd.tgNone')}</Badge>}
          </p>
          {(!tg || tg.optedOutAt) && (
            <>
              <div className="toolbar">
                <button className="btn btn-sm" onClick={() => void run(async () => setTgLink((await api<{ url: string }>(`/automations/patients/${p.id}/telegram-link`, { method: 'POST' })).url))}>{t('pd.tgConnect')}</button>
              </div>
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
      )}
    </>
  );
}
