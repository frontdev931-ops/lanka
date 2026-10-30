'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, download } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { fmtDateTime, initials } from '../../../lib/ui';
import { SecurityCard } from '../../../components/SecurityCard';
import { ProfileCard } from '../../../components/ProfileCard';
import { PlanCard } from '../../../components/PlanCard';
import { PushCard } from '../../../components/PushCard';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Alert, Badge, Card, Empty, Icon, PageHeader } from '../../../components/ui';
import { WorkHours } from '../../../components/WorkHours';

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface Pending {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

interface AuditRow {
  id: string;
  action: string;
  createdAt: string;
  user: string | null;
}

const ASSIGNABLE = ['MANAGER', 'ADMIN', 'DOCTOR', 'ANALYST'];

export default function SettingsPage() {
  const router = useRouter();
  const { t, label } = useI18n();
  const { ask, dialog } = useConfirm();
  const [info, setInfo] = useState('');
  const [role, setRole] = useState<string | null>(null);
  const [team, setTeam] = useState<Member[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [audit, setAudit] = useState<{ rows: AuditRow[]; total: number; page: number; pageSize: number } | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const isOwner = role === 'OWNER';
  const canAudit = role === 'OWNER' || role === 'MANAGER';

  // The server shows the team only to the owner, the manager and the administrator: a doctor or an analyst does not ask
  const loadTeam = useCallback(() => {
    api<Member[]>('/team').then(setTeam).catch(() => undefined);
  }, []);
  const loadPending = useCallback(() => {
    api<Pending[]>('/team/invitations').then(setPending).catch(() => undefined);
  }, []);

  useEffect(() => {
    loadTeam();
    api<{ role: string }>('/auth/me').then((m) => setRole(m.role)).catch(() => undefined);
  }, [loadTeam]);
  useEffect(() => {
    if (isOwner) loadPending();
  }, [isOwner, loadPending]);
  useEffect(() => {
    if (!canAudit) return;
    api<typeof audit>(`/clinic/audit?page=${auditPage}`).then(setAudit).catch((e) => setError((e as Error).message));
  }, [canAudit, auditPage]);

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setError('');
    setLink('');
    setCopied(false);
    try {
      const r = await api<{ link: string }>('/team/invitations', { method: 'POST', body: JSON.stringify(f) });
      setLink(r.link);
      form.reset();
      loadPending();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(id: string) {
    await api(`/team/invitations/${id}`, { method: 'DELETE' }).catch((e) => setError((e as Error).message));
    loadPending();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      /* без доступа к буферу обмена ссылку можно выделить и скопировать вручную */
    }
  }

  async function removeClinic(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setError('');
    try {
      await api('/clinic', { method: 'DELETE', body: JSON.stringify(f) });
      router.replace('/login');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const actionLabel = (a: string) => label('audit', a);

  return (
    <>
      <PageHeader title={t('set.title')} subtitle={t('set.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}

      {dialog}
      {info && <Alert tone="success">{info}</Alert>}
      <ProfileCard />
      <SecurityCard />
      <PushCard />
      {canAudit && <PlanCard isOwner={isOwner} />}

      <Card flush title={t('set.team')}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('set.colEmployee')}</th><th>{t('set.colEmail')}</th><th>{t('set.colRole')}</th>{isOwner && <th>{t('set.colActions')}</th>}</tr></thead>
            <tbody>
              {team.map((m) => (
                <tr key={m.id}>
                  <td>
                    <span className="toolbar">
                      <span className="avatar">{initials(m.name)}</span>
                      <span className="cell-main">{m.name}</span>
                    </span>
                  </td>
                  <td>{m.email}</td>
                  <td>
                    {isOwner && m.role !== 'OWNER' ? (
                      <select
                        className="select"
                        value={m.role}
                        aria-label={t('set.colRole')}
                        onChange={(e) =>
                          api(`/team/members/${m.id}`, { method: 'PATCH', body: JSON.stringify({ role: e.target.value }) })
                            .then(() => { setInfo(t('common.saved')); loadTeam(); })
                            .catch((err) => setError((err as Error).message))
                        }
                      >
                        {ASSIGNABLE.map((r) => (
                          <option key={r} value={r}>{label('role', r)}</option>
                        ))}
                      </select>
                    ) : (
                      <Badge tone={m.role === 'OWNER' ? 'teal' : 'gray'}>{label('role', m.role)}</Badge>
                    )}
                  </td>
                  {isOwner && (
                    <td>
                      {m.role !== 'OWNER' && (
                        <span className="toolbar">
                          <button
                            className="btn btn-sm"
                            onClick={async () => (await ask(t('set.reset2faConfirm', { name: m.name }), { confirmLabel: t('set.reset2fa') })) && api(`/team/members/${m.id}/reset-2fa`, { method: 'POST' }).then(() => setInfo(t('set.reset2faDone'))).catch((err) => setError((err as Error).message))}
                          >
                            {t('set.reset2fa')}
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={async () => (await ask(t('set.removeConfirm', { name: m.name }), { danger: true, confirmLabel: t('set.remove') })) && api(`/team/members/${m.id}`, { method: 'DELETE' }).then(() => { setInfo(t('set.removed')); loadTeam(); }).catch((err) => setError((err as Error).message))}
                          >
                            {t('set.remove')}
                          </button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {isOwner && (
        <>
          <Card title={t('set.inviteTitle')}>
            <p className="rule">{t('set.inviteHint')}</p>
            <form onSubmit={invite} className="toolbar">
              <input className="input" name="email" type="email" placeholder={t('login.email')} required />
              <select className="select" name="role" defaultValue="ADMIN">
                {ASSIGNABLE.map((r) => <option key={r} value={r}>{label('role', r)}</option>)}
              </select>
              <button type="submit" className="btn btn-primary"><Icon name="plus" size={16} /> {t('set.inviteBtn')}</button>
            </form>
            {link && (
              <div style={{ marginTop: 14 }}>
                <p className="rule" style={{ marginBottom: 6 }}>{t('set.inviteLink')}</p>
                <div className="code-box">
                  <span style={{ flex: 1 }}>{link}</span>
                  <button type="button" className="btn btn-sm" onClick={copy}><Icon name="copy" size={14} /> {copied ? t('common.copied') : t('common.copy')}</button>
                </div>
              </div>
            )}
          </Card>

          <Card flush title={t('set.pending')}>
            {pending.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>{t('set.colEmail')}</th><th>{t('set.colRole')}</th><th>{t('set.colExpires')}</th><th></th></tr></thead>
                  <tbody>
                    {pending.map((p) => (
                      <tr key={p.id}>
                        <td>{p.email}</td>
                        <td>{label('role', p.role)}</td>
                        <td>{fmtDateTime(p.expiresAt)}</td>
                        <td><button className="btn btn-sm btn-danger" onClick={() => revoke(p.id)}>{t('set.revoke')}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title={t('set.noPending')} />
            )}
          </Card>
        </>
      )}

      {canAudit && <WorkHours />}

      {canAudit && (
        <Card flush title={t('set.audit')}>
          <p className="rule" style={{ padding: '0 20px' }}>{t('set.auditHint')}</p>
          {audit && audit.rows.length ? (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>{t('set.colWhen')}</th><th>{t('set.colWho')}</th><th>{t('set.colAction')}</th></tr></thead>
                  <tbody>
                    {audit.rows.map((r) => (
                      <tr key={r.id}>
                        <td>{fmtDateTime(r.createdAt)}</td>
                        <td>{r.user ?? <span className="muted">{t('set.system')}</span>}</td>
                        <td>{actionLabel(r.action)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-foot">
                <span>{t('pat.page', { page: audit.page, pages: Math.max(1, Math.ceil(audit.total / audit.pageSize)) })}</span>
                <span className="toolbar">
                  <button className="btn btn-sm" disabled={auditPage <= 1} onClick={() => setAuditPage(auditPage - 1)}><Icon name="back" size={14} /> {t('common.back')}</button>
                  <button className="btn btn-sm" disabled={auditPage * audit.pageSize >= audit.total} onClick={() => setAuditPage(auditPage + 1)}>{t('common.forward')} <Icon name="next" size={14} /></button>
                </span>
              </div>
            </>
          ) : (
            <Empty title="—" />
          )}
        </Card>
      )}

      {isOwner && (
        <>
          <Card title={t('set.data')}>
            <p className="rule">{t('set.exportHint')}</p>
            <button className="btn" onClick={() => download('/clinic/export', 'clinic-export.json').catch((e) => setError((e as Error).message))}>
              <Icon name="download" size={16} /> {t('set.exportBtn')}
            </button>
          </Card>

          <section className="card danger-zone">
            <div className="card-head"><h2>{t('set.dangerTitle')}</h2></div>
            <p className="rule">{t('set.dangerHint')}</p>
            <form onSubmit={removeClinic} className="toolbar">
              <input className="input" name="confirmName" placeholder={t('set.confirmName')} required autoComplete="off" />
              <input className="input" name="password" type="password" placeholder={t('set.confirmPassword')} required autoComplete="current-password" />
              <button type="submit" className="btn btn-danger"><Icon name="trash" size={16} /> {t('set.deleteBtn')}</button>
            </form>
          </section>
        </>
      )}
    </>
  );
}
