'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { MoneyTotal, currencyCell, fmtDate, fmtNumber, fmtTotals } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';
import { useConfirm } from '../../../components/ConfirmDialog';
import { BillingPaymentStatus, type BillingCheckout } from '../../../components/BillingPaymentStatus';

interface NetBranch {
  id: string;
  name: string;
  role: string | null;
  authorized: boolean;
  setupQuoteUah: number | null;
  setupPaid: boolean;
}
interface Net {
  id: string;
  name: string;
  role: string;
  billingStatus: string;
  paidUntil: string | null;
  digest: string;
  branches: NetBranch[];
}
interface Row {
  id?: string;
  name?: string;
  records: number;
  newCards: number;
  visited: number;
  noShow: number;
  cancelled: number;
  booked: number;
  inquiries: number;
  noShowRate: number | null;
  cancelRate: number | null;
  paid: MoneyTotal[];
  dataUpdatedAt: string | null;
}
interface Summary {
  days: number;
  from: string;
  to: string;
  branches: Row[];
  total: Row;
}
interface Billing {
  configured: boolean;
  status: string;
  paidUntil: string | null;
  branches: number;
  monthlyUah: number;
  setupUah: number | null;
  branchSetups: { clinicId: string; name: string; quoteUah: number }[];
  pendingPaymentId: string | null;
  // what the next payment does (the server's rule): the amount now, the month it covers, the renewal after it, who gets paid access with it
  nextPayment: { chargeNowUah: number; monthlyUah: number; setupUah: number | null; coversFrom: string; coversTo: string; renewal: { date: string; amountUah: number }; branchesGettingAccess: string[]; branchesCovered: string[]; complimentaryUntil: string | null; blocked: 'next_period_paid' | 'payment_pending' | null; uncoveredAfterPrepaid: string[] };
}
interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
  branches: { name: string; role: string }[];
}
interface Report {
  title: string;
  rule: string;
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
}
const PERIODS = [7, 30, 90] as const;

// "Reports and analytics" → "Network" (shown only to a member of a network). Everything here is computed by the server per branch with that branch's own
// data, and only for the branches where the person has a management role (the server decides; this page never names a branch it was not given).
// Totals add counts; rates come from the added counts; patients are branch records (people are not matched across branches); money is per currency.
export default function NetworkPage() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [nets, setNets] = useState<Net[] | null>(null);
  const [netId, setNetId] = useState('');
  const [days, setDays] = useState<number>(30);
  const [sum, setSum] = useState<Summary | null>(null);
  const [bill, setBill] = useState<Billing | null>(null);
  const [signals, setSignals] = useState<{ branch: string; kind: string; value: number; threshold: number; fired: boolean }[]>([]);
  const [catalog, setCatalog] = useState<{ id: string; title: string }[]>([]);
  const [reportId, setReportId] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ answer: string; report: Report | null } | null>(null);
  const [newName, setNewName] = useState('');
  const [terms, setTerms] = useState(false);
  const [own, setOwn] = useState<{ id: string; name: string; role: string }[]>([]);
  const [attachId, setAttachId] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [memberEmail, setMemberEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [payment, setPayment] = useState<{ networkId: string; id: string } | null>(null);

  const loadNets = useCallback(() => {
    api<Net[]>('/billing/networks')
      .then((n) => {
        setNets(n);
        const requested = new URLSearchParams(window.location.search).get('network');
        setNetId((cur) => cur || n.find((net) => net.id === requested)?.id || n[0]?.id || '');
      })
      .catch((e) => setError((e as Error).message));
    api<{ id: string; name: string; role: string }[]>('/auth/clinics').then(setOwn).catch(() => undefined);
    api<{ id: string; title: string }[]>('/reports').then((c) => setCatalog(c.map((x) => ({ id: x.id, title: x.title })))).catch(() => undefined);
  }, []);
  useEffect(loadNets, [loadNets]);
  const net = nets?.find((n) => n.id === netId) ?? null;
  const owner = net?.role === 'OWNER';
  useEffect(() => {
    if (!netId || !owner) return setMembers([]);
    api<Member[]>(`/network/${netId}/members`).then(setMembers).catch(() => setMembers([]));
  }, [netId, owner, nets]);

  // The data of an unpaid network (or one past its grace days) are closed like a clinic's: only billing and the branches are shown then
  const paid = net?.billingStatus === 'ACTIVE' || net?.billingStatus === 'PAST_DUE';
  useEffect(() => {
    if (!netId) return;
    setSum(null);
    api<Billing>(`/billing/network/${netId}`).then(setBill).catch(() => setBill(null));
    if (!paid) return;
    api<Summary>(`/network/${netId}/summary?days=${days}`).then(setSum).catch((e) => setError((e as Error).message));
    api<{ signals: typeof signals }>(`/network/${netId}/signals`).then((r) => setSignals(r.signals)).catch(() => setSignals([]));
  }, [netId, days, paid]);
  useEffect(() => {
    if (!netId || !reportId) return setReport(null);
    setReport(null);
    api<Report>(`/network/${netId}/reports/${reportId}`).then(setReport).catch((e) => setError((e as Error).message));
  }, [netId, reportId]);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const networkId = query.get('network');
    const id = query.get('payment');
    if (networkId && id) setPayment({ networkId, id });
  }, []);
  const refreshPayment = useCallback(() => {
    if (netId) void api<Billing>(`/billing/network/${encodeURIComponent(netId)}`).then(setBill).catch(() => undefined);
    loadNets();
  }, [netId, loadNets]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
      loadNets();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pay = (path: string) => run(async () => {
    const result = await api<BillingCheckout>(path, { method: 'POST' });
    if (result.url) window.location.assign(result.url);
    else {
      setPayment({ networkId: netId, id: result.id });
      refreshPayment();
    }
  });
  const money = (list: MoneyTotal[]) => fmtTotals(list, t('billing.uah'), t('money.unknown'));
  const pct = (v: number | null) => (v === null ? '—' : `${fmtNumber(v)}%`);

  const askAi = async (e: FormEvent) => {
    e.preventDefault();
    if (question.trim().length < 2) return;
    await run(async () => setAnswer(await api(`/network/${netId}/assistant`, { method: 'POST', body: JSON.stringify({ question: question.trim(), history: [] }) })));
  };

  if (!nets) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  if (!nets.length)
    return (
      <>
        <PageHeader title={t('net.title')} subtitle={t('net.subtitle')} />
        <Empty title={t('net.none')}>{t('net.noneHint')}</Empty>
      </>
    );

  const table = (r: Report) => (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {r.columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.rows.slice(0, 300).map((row, i) => (
            <tr key={i}>
              {r.columns.map((c) => (
                <td key={c.key}>{c.key === 'currency' ? currencyCell(row[c.key], t('money.unknownShort'), t('money.several')) : typeof row[c.key] === 'number' ? fmtNumber(row[c.key] as number) : String(row[c.key] ?? '—')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  const freeClinics = own.filter((c) => c.role === 'OWNER' && !nets.some((n) => n.branches.some((b) => b.id === c.id)));

  const trackedPayment = payment?.networkId === net?.id ? payment?.id : bill?.pendingPaymentId;

  return (
    <>
      {dialog}
      <PageHeader title={t('net.title')} subtitle={t('net.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      {nets.length > 1 && (
        <div className="toolbar">
          <label className="field" style={{ margin: 0 }}>
            <span>{t('net.choose')}</span>
            <select className="input" value={netId} onChange={(e) => setNetId(e.target.value)}>
              {nets.map((n) => (
                <option key={n.id} value={n.id}>{n.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {net && (
        <Card title={net.name} actions={<Badge tone={net.billingStatus === 'ACTIVE' ? 'green' : 'amber'}>{t(`net.st.${net.billingStatus}` as never)}</Badge>}>
          <p className="rule" style={{ marginTop: 0 }}>{t('net.rules')}</p>
          <ul className="terms-list">
            {net.branches.map((b) => (
              <li key={b.id}>
                <b>{b.name}</b> {b.authorized ? '' : <span className="muted">· {t('net.notAuthorized')}</span>}
                {owner && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="link-btn"
                      disabled={busy}
                      onClick={async () => {
                        if (await ask(t('net.detachConfirm', { name: b.name }), { title: t('net.detach'), confirmLabel: t('net.detach'), danger: true })) run(() => api(`/network/${net.id}/branches/${b.id}`, { method: 'DELETE' }), t('common.saved'));
                      }}
                    >
                      {t('net.detach')}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!paid && <Alert tone="info">{t('net.unpaid')}</Alert>}
      {paid && (
      <Card
        title={t('net.compare')}
        actions={
          <div className="toolbar" role="group" aria-label={t('net.compare')}>
            {PERIODS.map((d) => (
              <button key={d} type="button" className={`btn btn-sm${days === d ? ' btn-primary' : ''}`} aria-pressed={days === d} onClick={() => setDays(d)}>
                {t('dash.lastDays', { n: d })}
              </button>
            ))}
          </div>
        }
      >
        {!sum ? (
          <Loading />
        ) : !sum.branches.length ? (
          <Empty title={t('net.noAccess')}>{t('net.noAccessHint')}</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('net.col.branch')}</th>
                    <th className="num">{t('net.col.records')}</th>
                    <th className="num">{t('net.col.newCards')}</th>
                    <th className="num">{t('net.col.booked')}</th>
                    <th className="num">{t('net.col.visited')}</th>
                    <th className="num">{t('net.col.noShow')}</th>
                    <th className="num">{t('net.col.cancelled')}</th>
                    <th className="num">{t('net.col.inquiries')}</th>
                    <th className="num">{t('net.col.paid')}</th>
                    <th>{t('net.col.updated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...sum.branches, { ...sum.total, name: t('net.total') }].map((r, i) => (
                    <tr key={r.id ?? `total-${i}`}>
                      <td>{r.id ? <span className="cell-main">{r.name}</span> : <b>{r.name}</b>}</td>
                      <td className="num">{fmtNumber(r.records)}</td>
                      <td className="num">{fmtNumber(r.newCards)}</td>
                      <td className="num">{fmtNumber(r.booked)}</td>
                      <td className="num">{fmtNumber(r.visited)}</td>
                      <td className="num">{fmtNumber(r.noShow)} ({pct(r.noShowRate)})</td>
                      <td className="num">{fmtNumber(r.cancelled)} ({pct(r.cancelRate)})</td>
                      <td className="num">{fmtNumber(r.inquiries)}</td>
                      <td className="num">{money(r.paid)}</td>
                      <td>{fmtDate(r.dataUpdatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>{t('net.countRule')}</p>
          </>
        )}
      </Card>
      )}

      {signals.length > 0 && (
        <Card title={t('net.signals')}>
          <ul className="terms-list">
            {signals.map((s, i) => (
              <li key={i}>
                {s.fired ? <Badge tone="amber">{t('net.fired')}</Badge> : <Badge tone="gray">{t('net.ok')}</Badge>} {s.branch}: {t(`net.kind.${s.kind}` as never)} {fmtNumber(s.value)} ({t('net.threshold', { n: s.threshold })})
              </li>
            ))}
          </ul>
        </Card>
      )}

      {paid && (
      <>
      <Card title={t('net.reports')}>
        <div className="toolbar">
          <label className="field" style={{ margin: 0 }}>
            <span>{t('net.report')}</span>
            <select className="input" value={reportId} onChange={(e) => setReportId(e.target.value)}>
              <option value="">—</option>
              {catalog.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
          </label>
          {reportId && (
            <span className="toolbar">
              {(['xlsx', 'pdf', 'csv'] as const).map((f) => (
                <a key={f} className="btn btn-sm" href={`/backend/network/${netId}/reports/${reportId}/${f}`}>{f.toUpperCase()}</a>
              ))}
            </span>
          )}
        </div>
        {reportId && !report && <Loading />}
        {report && (
          <>
            <p className="rule">{report.rule}</p>
            {report.rows.length ? table(report) : <Empty title={t('net.emptyReport')}>{''}</Empty>}
          </>
        )}
      </Card>

      <Card title={t('net.assistant')}>
        <form className="toolbar" onSubmit={askAi}>
          <label className="field" style={{ margin: 0, flex: 1, minWidth: 220 }}>
            <span>{t('net.question')}</span>
            <input className="input" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={600} placeholder={t('net.questionHint')} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || question.trim().length < 2}>{t('net.ask')}</button>
        </form>
        <p className="muted" style={{ fontSize: 13 }}>{t('net.assistantRule')}</p>
        {answer && (
          <>
            <p>{answer.answer}</p>
            {answer.report && table(answer.report)}
          </>
        )}
      </Card>
      </>
      )}

      {bill && net && (
        <Card title={t('net.billing')}>
          {!bill.configured && <Alert tone="warn">{t('billing.notConfigured')}</Alert>}
          {trackedPayment && <BillingPaymentStatus key={net.id + ':' + trackedPayment} path={`/billing/network/${encodeURIComponent(net.id)}/payments/${encodeURIComponent(trackedPayment)}`} onSettled={refreshPayment} />}
          <p className="rule" style={{ marginTop: 0 }}>{t('net.price', { n: bill.branches, sum: fmtNumber(bill.monthlyUah) })}</p>
          <p className="muted" style={{ fontSize: 13 }}>{bill.paidUntil ? t('net.paidUntil', { date: fmtDate(bill.paidUntil) }) : t('net.notPaid')}</p>
          {/* everything the next payment does, before the person pays */}
          <section className="rule-card" style={{ margin: '8px 0 12px' }}>
            <b>{t('net.next.title')}</b>
            {bill.nextPayment.blocked === 'next_period_paid' ? (
              <>
                <p style={{ margin: '8px 0' }}>{t('net.next.prepaid', { date: fmtDate(bill.paidUntil) })}</p>
                {bill.nextPayment.uncoveredAfterPrepaid.length > 0 && (
                  <Alert tone="warn">
                    {t('net.next.uncovered', { names: bill.nextPayment.uncoveredAfterPrepaid.join(', ') })} <a href="mailto:hello@lankaclinic.app">hello@lankaclinic.app</a>
                  </Alert>
                )}
              </>
            ) : (
              <ul className="terms-list" style={{ marginTop: 8 }}>
                <li>{t('net.next.now', { sum: fmtNumber(bill.nextPayment.chargeNowUah) })}{bill.nextPayment.setupUah ? ` ${t('net.next.incl', { m: fmtNumber(bill.nextPayment.monthlyUah), s: fmtNumber(bill.nextPayment.setupUah) })}` : ''}</li>
                <li>{t('net.next.covers', { from: fmtDate(bill.nextPayment.coversFrom), to: fmtDate(bill.nextPayment.coversTo) })}</li>
                <li>{t('net.next.covered', { names: bill.nextPayment.branchesCovered.join(', ') })}</li>
                <li>{bill.nextPayment.branchesGettingAccess.length ? t('net.next.access', { names: bill.nextPayment.branchesGettingAccess.join(', ') }) : t('net.next.accessAll')}</li>
                {bill.nextPayment.complimentaryUntil && bill.nextPayment.branchesGettingAccess.length > 0 && <li>{t('net.next.free', { date: fmtDate(bill.nextPayment.complimentaryUntil) })}</li>}
                <li>{t('net.next.renewal', { date: fmtDate(bill.nextPayment.renewal.date), sum: fmtNumber(bill.nextPayment.renewal.amountUah) })}</li>
                {bill.branchSetups.length > 0 && <li>{t('net.next.setupSeparate')}</li>}
              </ul>
            )}
            {bill.nextPayment.blocked === 'payment_pending' && <Alert tone="info">{t('net.next.pending')}</Alert>}
          </section>
          {owner ? (
            <>
              <button type="button" className="btn btn-primary" disabled={busy || !bill.configured || !!bill.nextPayment.blocked} onClick={() => pay(`/billing/network/${net.id}/checkout`)}>
                {t('billing.pay')}
              </button>
              {bill.branchSetups.map((b) => (
                <div key={b.clinicId} className="toolbar" style={{ marginTop: 10 }}>
                  <span>{t('net.branchSetup', { name: b.name, sum: fmtNumber(b.quoteUah) })}</span>
                  <button type="button" className="btn" disabled={busy || !bill.configured} onClick={() => pay(`/billing/network/${net.id}/branch-setup/${b.clinicId}`)}>{t('billing.pay')}</button>
                </div>
              ))}
              <p className="muted" style={{ fontSize: 13 }}>{t('net.branchSetupRule')}</p>
            </>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>{t('net.ownerPays')}</p>
          )}
        </Card>
      )}

      {owner && net && (
        <Card title={t('net.manage')}>
          <form
            className="toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => api(`/network/${net.id}/branches`, { method: 'POST', body: JSON.stringify({ name: newName.trim(), acceptTerms: terms }) }), t('net.created')).then(() => setNewName(''));
            }}
          >
            <label className="field" style={{ margin: 0, flex: 1, minWidth: 200 }}>
              <span>{t('net.newBranch')}</span>
              <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} />
            </label>
            <label className="check-row" style={{ margin: 0 }}>
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
              <span>{t('net.acceptTerms')}</span>
            </label>
            <button type="submit" className="btn" disabled={busy || newName.trim().length < 2 || !terms}>{t('net.create')}</button>
          </form>
          <p className="muted" style={{ fontSize: 13 }}>{t('net.newBranchRule')}</p>
          {freeClinics.length > 0 && (
            <div className="toolbar">
              <label className="field" style={{ margin: 0 }}>
                <span>{t('net.attach')}</span>
                <select className="input" value={attachId} onChange={(e) => setAttachId(e.target.value)}>
                  <option value="">—</option>
                  {freeClinics.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn"
                disabled={busy || !attachId}
                onClick={async () => {
                  if (!(await ask(t('net.attachConfirm'), { title: t('net.attach'), confirmLabel: t('net.attach') }))) return;
                  run(() => api(`/network/${net.id}/branches/attach`, { method: 'POST', body: JSON.stringify({ clinicId: attachId, confirmEndOwnSubscription: true }) }), t('common.saved'));
                }}
              >
                {t('net.attach')}
              </button>
            </div>
          )}
          <section className="rule-card" style={{ marginTop: 12 }}>
            <b>{t('net.team')}</b>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0' }}>{t('net.teamHow')}</p>
            <ul className="terms-list" style={{ marginTop: 8 }}>
              {members.map((m) => (
                <li key={m.userId}>
                  <b>{m.name}</b> <span className="muted">{m.email}</span> — {m.branches.length ? m.branches.map((b) => `${b.name} (${t(`role.${b.role}` as never)})`).join(', ') : t('net.teamNoBranch')}
                  {m.role !== 'OWNER' && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="link-btn"
                        disabled={busy}
                        onClick={async () => {
                          if (await ask(t('net.teamRemoveConfirm', { name: m.name }), { title: t('net.team'), confirmLabel: t('net.teamRemove'), danger: true })) run(() => api(`/network/${net.id}/members/${m.userId}`, { method: 'DELETE' }), t('common.saved'));
                        }}
                      >
                        {t('net.teamRemove')}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <form
              className="toolbar"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => api(`/network/${net.id}/members`, { method: 'POST', body: JSON.stringify({ email: memberEmail.trim() }) }), t('common.saved')).then(() => setMemberEmail(''));
              }}
            >
              <label className="field" style={{ margin: 0, flex: 1, minWidth: 200 }}>
                <span>{t('net.teamEmail')}</span>
                <input className="input" type="email" value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} />
              </label>
              <button type="submit" className="btn" disabled={busy || !memberEmail.includes('@')}>{t('net.teamAdd')}</button>
            </form>
          </section>
          <div className="toolbar" style={{ marginTop: 12 }}>
            <label className="field" style={{ margin: 0 }}>
              <span>{t('net.digest')}</span>
              <select className="input" value={net.digest} onChange={(e) => run(() => api(`/network/${net.id}/digest`, { method: 'PATCH', body: JSON.stringify({ digest: e.target.value }) }), t('common.saved'))}>
                {['OFF', 'WEEKLY', 'DAILY'].map((d) => (
                  <option key={d} value={d}>{t(`net.digest.${d}` as never)}</option>
                ))}
              </select>
            </label>
          </div>
        </Card>
      )}

    </>
  );
}
