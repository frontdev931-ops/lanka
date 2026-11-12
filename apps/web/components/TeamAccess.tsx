'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtDateTime, initials } from '../lib/ui';
import { useConfirm } from './ConfirmDialog';
import { Alert, Badge, Card, Empty, Icon } from './ui';
import { Switch } from './Switch';
import { LineTabs } from './LineTabs';
import { SecurityCard } from './SecurityCard';

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  // given by the server to the owner only: whether the member has set up two-factor sign-in
  twoFactor?: boolean;
}
interface Pending {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

const ASSIGNABLE = ['MANAGER', 'ADMIN', 'DOCTOR', 'ANALYST'];

// "Team and access": the staff and the pending invitations, and for the owner the clinic-wide two-factor requirement and each member's two-factor state.
// The server supports ONE requirement for the whole clinic (Clinic.require2fa): there is no per-member requirement, so no per-member switch is shown; the
// column shows whether each member has set it up. Every action is the existing endpoint with its own permission (the owner only for invitations and 2FA).
// The owner's own two-factor setup (the same SecurityCard everyone else has in General) opens from their own row.
export function TeamAccess({ role, myEmail }: { role: string | null; myEmail: string | null }) {
  const { t, label } = useI18n();
  const { ask, dialog } = useConfirm();
  const isOwner = role === 'OWNER';
  const [team, setTeam] = useState<Member[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [require2fa, setRequire2fa] = useState<boolean | null>(null);
  const [tab, setTab] = useState<'staff' | 'invites'>('staff');
  const [inviting, setInviting] = useState(false);
  const [mine, setMine] = useState(false);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const loadTeam = useCallback(() => api<Member[]>('/team').then(setTeam).catch(() => undefined), []);
  const loadPending = useCallback(() => api<Pending[]>('/team/invitations').then(setPending).catch(() => undefined), []);
  useEffect(() => {
    loadTeam();
  }, [loadTeam]);
  useEffect(() => {
    if (!isOwner) return;
    loadPending();
    api<{ require2fa: boolean }>('/service/usage').then((o) => setRequire2fa(o.require2fa)).catch(() => undefined);
  }, [isOwner, loadPending]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setLink('');
    setCopied(false);
    await run(async () => {
      const r = await api<{ link: string }>('/team/invitations', { method: 'POST', body: JSON.stringify(f) });
      setLink(r.link);
      form.reset();
      loadPending();
    });
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      /* without access to the clipboard the link can be selected and copied by hand */
    }
  }

  const twoFactorState = (m: Member) => (m.twoFactor ? { tone: 'green' as const, text: t('team.2faSet') } : require2fa ? { tone: 'amber' as const, text: t('team.2faNeeded') } : { tone: 'gray' as const, text: t('team.2faNotSet') });

  return (
    <>
    <Card
      flush
      title={t('team.title')}
      actions={isOwner ? <button className="btn btn-sm btn-primary" onClick={() => { setInviting((v) => !v); setLink(''); setTab('invites'); }}><Icon name="plus" size={14} /> {t('team.invite')}</button> : undefined}
    >
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      {isOwner && require2fa !== null && (
        <div style={{ padding: '0 20px' }}>
          <Switch
            checked={require2fa}
            disabled={busy}
            label={t('plan.require2fa')}
            hint={t('plan.require2faHint')}
            onChange={(on) => run(async () => { const o = await api<{ require2fa: boolean }>('/service/security', { method: 'PATCH', body: JSON.stringify({ require2fa: on }) }); setRequire2fa(o.require2fa); }, t('common.saved'))}
          />
        </div>
      )}

      {isOwner && (
        <div style={{ padding: '0 20px' }}>
          <LineTabs id="team" label={t('team.title')} tabs={['staff', 'invites'] as const} active={tab} onPick={setTab} render={(k) => (k === 'staff' ? t('team.tabStaff') : `${t('team.tabInvites')} · ${pending.length}`)} />
        </div>
      )}

      {tab === 'staff' || !isOwner ? (
        <div className="table-wrap" role={isOwner ? 'tabpanel' : undefined} id="team-panel-staff" aria-labelledby={isOwner ? 'team-tab-staff' : undefined}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('set.colEmployee')}</th>
                <th>{t('set.colEmail')}</th>
                <th>{t('set.colRole')}</th>
                {isOwner && <th>{t('team.col2fa')}</th>}
                {isOwner && <th>{t('set.colActions')}</th>}
              </tr>
            </thead>
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
                      <select className="select" value={m.role} aria-label={t('set.colRole')} disabled={busy} onChange={(e) => run(() => api(`/team/members/${m.id}`, { method: 'PATCH', body: JSON.stringify({ role: e.target.value }) }).then(loadTeam), t('common.saved'))}>
                        {ASSIGNABLE.map((r) => <option key={r} value={r}>{label('role', r)}</option>)}
                      </select>
                    ) : (
                      <Badge tone={m.role === 'OWNER' ? 'teal' : 'gray'}>{label('role', m.role)}</Badge>
                    )}
                  </td>
                  {isOwner && (
                    <td>
                      <Badge tone={twoFactorState(m).tone}>{twoFactorState(m).text}</Badge>
                    </td>
                  )}
                  {isOwner && (
                    <td>
                      {myEmail && m.email === myEmail ? (
                        <button className="btn btn-sm" aria-expanded={mine} aria-controls="my-2fa" onClick={() => { setMine((v) => !v); if (!mine) setTimeout(() => document.getElementById('my-2fa')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); }}>
                          {t('team.my2fa')}
                        </button>
                      ) : m.role !== 'OWNER' && (
                        <span className="toolbar">
                          {m.twoFactor && (
                            <button className="btn btn-sm" disabled={busy} onClick={async () => (await ask(t('set.reset2faConfirm', { name: m.name }), { confirmLabel: t('set.reset2fa') })) && run(() => api(`/team/members/${m.id}/reset-2fa`, { method: 'POST' }).then(loadTeam), t('set.reset2faDone'))}>
                              {t('set.reset2fa')}
                            </button>
                          )}
                          <button className="btn btn-sm" disabled={busy} onClick={async () => (await ask(t('set.removeConfirm', { name: m.name }), { danger: true, confirmLabel: t('set.remove') })) && run(() => api(`/team/members/${m.id}`, { method: 'DELETE' }).then(loadTeam), t('set.removed'))}>
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
      ) : (
        <div role="tabpanel" id="team-panel-invites" aria-labelledby="team-tab-invites">
          {inviting && (
            <section className="rule-card" style={{ margin: '0 20px 14px' }}>
              <p className="rule" style={{ marginTop: 0 }}>{t('set.inviteHint')}</p>
              <form onSubmit={invite} className="toolbar">
                <input className="input" name="email" type="email" placeholder={t('login.email')} aria-label={t('login.email')} required />
                <select className="select" name="role" defaultValue="ADMIN" aria-label={t('set.colRole')}>
                  {ASSIGNABLE.map((r) => <option key={r} value={r}>{label('role', r)}</option>)}
                </select>
                <button type="submit" className="btn btn-primary" disabled={busy}>{t('set.inviteBtn')}</button>
                <button type="button" className="btn" onClick={() => { setInviting(false); setLink(''); }}>{t('common.cancel')}</button>
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
            </section>
          )}
          {pending.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t('set.colEmail')}</th><th>{t('set.colRole')}</th><th>{t('set.colExpires')}</th><th>{t('set.colActions')}</th></tr></thead>
                <tbody>
                  {pending.map((p) => (
                    <tr key={p.id}>
                      <td>{p.email}</td>
                      <td>{label('role', p.role)}</td>
                      <td>{fmtDateTime(p.expiresAt)}</td>
                      <td><button className="btn btn-sm btn-danger" disabled={busy} onClick={() => run(() => api(`/team/invitations/${p.id}`, { method: 'DELETE' }).then(loadPending))}>{t('set.revoke')}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !inviting && <Empty title={t('set.noPending')} />
          )}
        </div>
      )}
    </Card>
    {isOwner && mine && (
      <div id="my-2fa">
        <SecurityCard />
      </div>
    )}
    </>
  );
}
