'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { fmtDate, fmtDateTime, fmtNumber } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';
import { useConfirm } from '../../../components/ConfirmDialog';

interface Row {
  id: string;
  name: string;
  createdAt: string;
  plan: string;
  billingStatus: string;
  bookingWriteEnabled: boolean;
  paidUntil: string | null;
  limits: { users: number; messagesPerMonth: number; aiRepliesPerMonth: number };
  suspended: boolean;
  sendingEnabled: boolean;
  aiEnabled: boolean;
  require2fa: boolean;
  users: number;
  patients: number;
  messagesThisMonth: number;
  aiRepliesThisMonth: number;
  aiTokensThisMonth: number;
  lastSyncAt: string | null;
}
interface PlanInfo {
  key: string;
  label: string;
  limits: Row['limits'];
}

// The service owner's overview: all clinics, their plan and usage; change a plan, set custom limits, suspend or resume a clinic
export default function PlatformPage() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [custom, setCustom] = useState<{ id: string; users: string; messages: string; ai: string } | null>(null);

  const load = useCallback(() => {
    api<Row[]>('/platform/clinics').then(setRows).catch((e) => setError((e as Error).message));
    api<PlanInfo[]>('/platform/plans').then(setPlans).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!info) return;
    const id = setTimeout(() => setInfo(''), 5000);
    return () => clearTimeout(id);
  }, [info]);

  const patch = async (id: string, body: object) => {
    setError('');
    try {
      await api(`/platform/clinics/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setInfo(t('common.saved'));
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!rows) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  const totals = rows.reduce((a, r) => ({ patients: a.patients + r.patients, messages: a.messages + r.messagesThisMonth, tokens: a.tokens + r.aiTokensThisMonth }), { patients: 0, messages: 0, tokens: 0 });

  return (
    <>
      {dialog}
      <PageHeader title={t('pf.title')} subtitle={t('pf.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <section className="card stat"><div className="stat-top">{t('pf.clinics')}</div><div className="stat-value">{rows.length}</div></section>
        <section className="card stat"><div className="stat-top">{t('pf.patients')}</div><div className="stat-value">{fmtNumber(totals.patients)}</div></section>
        <section className="card stat"><div className="stat-top">{t('pf.messages')}</div><div className="stat-value">{fmtNumber(totals.messages)}</div></section>
        <section className="card stat"><div className="stat-top">{t('pf.tokens')}</div><div className="stat-value">{fmtNumber(totals.tokens)}</div></section>
      </div>

      <Card flush title={t('pf.clinics')}>
        {rows.length === 0 ? (
          <Empty title="—" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('pf.colClinic')}</th>
                  <th>{t('pf.colPlan')}</th>
                  <th>{t('pf.colBilling')}</th>
                  <th>{t('pf.colUsers')}</th>
                  <th>{t('pf.colMessages')}</th>
                  <th>{t('pf.colAi')}</th>
                  <th>{t('pf.colSync')}</th>
                  <th>{t('pf.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="cell-main">{r.name}</div>
                      <div className="cell-sub">{fmtDate(r.createdAt)} {r.suspended && <Badge tone="amber">{t('pf.suspended')}</Badge>}</div>
                    </td>
                    <td>
                      <select className="select" value={r.plan} onChange={(e) => patch(r.id, { plan: e.target.value })} aria-label={t('pf.colPlan')}>
                        {plans.map((p) => (
                          <option key={p.key} value={p.key}>{p.label}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Badge tone={r.billingStatus === 'ACTIVE' ? 'green' : r.billingStatus === 'PAST_DUE' ? 'amber' : 'red'}>{r.billingStatus}</Badge>
                      <div className="cell-sub">{r.paidUntil ? fmtDate(r.paidUntil) : '—'}</div>
                    </td>
                    <td>{r.users} / {r.limits.users}</td>
                    <td>{r.messagesThisMonth} / {r.limits.messagesPerMonth}</td>
                    <td>{r.aiRepliesThisMonth} / {r.limits.aiRepliesPerMonth}</td>
                    <td>{r.lastSyncAt ? fmtDateTime(r.lastSyncAt) : '—'}</td>
                    <td>
                      <span className="toolbar">
                        <button
                          className="btn btn-sm"
                          onClick={async () => {
                            if (!r.bookingWriteEnabled && !(await ask(t('pf.bookingConfirm', { name: r.name }), { danger: true, confirmLabel: t('pf.bookingOn') }))) return;
                            patch(r.id, { bookingWriteEnabled: !r.bookingWriteEnabled });
                          }}
                        >
                          {r.bookingWriteEnabled ? t('pf.bookingOff') : t('pf.bookingOn')}
                        </button>
                        <button className="btn btn-sm" onClick={() => patch(r.id, { billingStatus: 'ACTIVE', paidUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() })}>{t('pf.activate')}</button>
                        <button className="btn btn-sm" onClick={() => setCustom({ id: r.id, users: String(r.limits.users), messages: String(r.limits.messagesPerMonth), ai: String(r.limits.aiRepliesPerMonth) })}>{t('pf.limits')}</button>
                        <button
                          className="btn btn-sm"
                          onClick={async () => {
                            if (!r.suspended && !(await ask(t('pf.suspendConfirm', { name: r.name }), { danger: true, confirmLabel: t('pf.suspend') }))) return;
                            patch(r.id, { suspended: !r.suspended });
                          }}
                        >
                          {r.suspended ? t('pf.resume') : t('pf.suspend')}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {custom && (
        <Card title={t('pf.limitsTitle')}>
          <p className="rule" style={{ marginTop: 0 }}>{t('pf.limitsHint')}</p>
          <div className="toolbar">
            {([['users', t('pf.colUsers')], ['messages', t('pf.colMessages')], ['ai', t('pf.colAi')]] as const).map(([k, label]) => (
              <label key={k} className="field" style={{ margin: 0 }}>
                <span>{label}</span>
                <input className="input" type="number" min={0} style={{ width: 130 }} value={custom[k]} onChange={(e) => setCustom({ ...custom, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button
              className="btn btn-primary"
              onClick={async () => {
                await patch(custom.id, { plan: 'CUSTOM', limits: { users: Number(custom.users), messagesPerMonth: Number(custom.messages), aiRepliesPerMonth: Number(custom.ai) }, aiMonthlyLimit: Number(custom.ai) });
                setCustom(null);
              }}
            >
              {t('common.save')}
            </button>
            <button className="btn" onClick={() => setCustom(null)}>{t('common.cancel')}</button>
          </div>
        </Card>
      )}
    </>
  );
}
