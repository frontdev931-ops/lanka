'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, download } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { fmtDateTime } from '../../../lib/ui';
import { SecurityCard } from '../../../components/SecurityCard';
import { TeamAccess } from '../../../components/TeamAccess';
import { IntegrationCard } from '../../../components/IntegrationCard';
import { LeaderTelegramCard } from '../../../components/LeaderTelegramCard';
import { LineTabs } from '../../../components/LineTabs';
import { Alert, Card, Empty, Icon, PageHeader } from '../../../components/ui';
import { WorkHours } from '../../../components/WorkHours';
import { ClinicContacts } from '../../../components/ClinicContacts';
import { ChannelSettings } from '../../../components/ChannelSettings';
import { BillingSettings } from '../../../components/BillingSettings';
import { SendingSettings } from '../../../components/SendingSettings';
import { AiGeneralSettings, AiLimitCard } from '../../../components/AiGeneralSettings';

interface Me {
  role: string;
  email: string;
  twoFactorRequired?: boolean;
  billing?: { demo: boolean; blocked: boolean };
}

interface AuditRow {
  id: string;
  action: string;
  createdAt: string;
  user: string | null;
}

// The tabs of Settings: the general part (everybody); the team (those the server shows the staff list to: the owner, the manager and the administrator; only the
// owner manages it); patient communication by task: channels (connections only), replies to patients (incoming conversations and booking from them),
// automatic messages (on a schedule or after an event) — the owner and the manager, the server allows only them to change it; the payment (the owner and
// the manager, not in the demo clinic) with the plan and its usage. The sending switch and the manager's assistant are in General. Replies to patients
// and booking moved to "AI administrator" (/ai-admin), the rules of automatic messages to "Reminders and campaigns" → "Rules" (/automations?view=rules).
// While the clinic is blocked until payment, the payment tab is the only one: the server closes the rest.
const TABS = ['general', 'team', 'channels', 'billing'] as const;
// old addresses: the tabs that moved out of Settings (replies to patients → "AI administrator", automatic messages → "Reminders and campaigns" → "Rules")
const MOVED: Record<string, string> = { ai: '/ai-admin', replies: '/ai-admin', messages: '/automations?view=rules' };
type Tab = (typeof TABS)[number];

export default function SettingsPage() {
  const router = useRouter();
  const { t, label } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const role = me?.role ?? null;
  const [audit, setAudit] = useState<{ rows: AuditRow[]; total: number; page: number; pageSize: number } | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const [error, setError] = useState('');

  const isOwner = role === 'OWNER';
  const canAudit = role === 'OWNER' || role === 'MANAGER';
  const [tab, setTab] = useState<Tab>('general');
  // the tab of the address is read after the first render: until then (and until the role is known) no panel is mounted, so the General
  // panel does not start its requests on the way to another tab (an unpaid clinic would get 403 for them)
  const [tabReady, setTabReady] = useState(false);
  const canPay = canAudit && !me?.billing?.demo;
  const tabs: Tab[] = me?.billing?.blocked ? ['billing'] : canAudit ? TABS.filter((k) => k !== 'billing' || canPay) : role === 'ADMIN' ? ['general', 'team'] : ['general'];
  // the tab of the address (?tab=channels), also after the return from a Facebook or Instagram login; a tab the role cannot open falls back to the general one
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('tab');
    if (q && MOVED[q]) router.replace(MOVED[q]);
    else if (q && (TABS as readonly string[]).includes(q)) setTab(q as Tab);
    setTabReady(true);
  }, [router]);
  const shown: Tab = role && !tabs.includes(tab) ? tabs[0] : tab;
  const pick = (next: Tab) => {
    setTab(next);
    const q = new URLSearchParams(window.location.search);
    q.delete('ch'); // the inner tab of "Channels"
    if (next === 'general') q.delete('tab');
    else q.set('tab', next);
    window.history.replaceState(null, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}`);
  };

  useEffect(() => {
    const load = () => api<Me>('/auth/me').then(setMe).catch(() => undefined);
    void load();
    window.addEventListener('stomat:me-changed', load);
    return () => window.removeEventListener('stomat:me-changed', load);
  }, []);
  useEffect(() => {
    if (!canAudit || me?.billing?.blocked) return;
    api<typeof audit>(`/clinic/audit?page=${auditPage}`).then(setAudit).catch((e) => setError((e as Error).message));
  }, [canAudit, auditPage, me?.billing?.blocked]);

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
      <PageHeader title={t('set.title')} subtitle={t(`set.sub.${shown}`)} />
      {tabs.length > 1 && <LineTabs id="set" label={t('set.title')} tabs={tabs} active={shown} onPick={pick} render={(k) => t(`set.tab.${k}`)} />}
      {tabReady && role && shown !== 'general' && (
        <div role="tabpanel" id={`set-panel-${shown}`} aria-labelledby={`set-tab-${shown}`}>
          {shown === 'team' && <TeamAccess role={role} myEmail={me?.email ?? null} />}
          {shown === 'channels' && <ChannelSettings />}
          {shown === 'billing' && (
            <BillingSettings canBuy={isOwner} />
          )}
        </div>
      )}
      {tabReady && role && shown === 'general' && (
      <div role={tabs.length > 1 ? 'tabpanel' : undefined} id="set-panel-general" aria-labelledby={tabs.length > 1 ? 'set-tab-general' : undefined}>
      {error && <Alert tone="error">{error}</Alert>}

      {/* the owner's own two-factor setup is on their row in "Team"; here it stays for everyone else, and for an owner the clinic already requires it from */}
      {me && (!isOwner || me.twoFactorRequired) && <SecurityCard />}
      <IntegrationCard />
      {canAudit && <SendingSettings />}
      {/* the manager's own Telegram for reports and signals (the LANKA service bot, not the clinic's patient bot) */}
      {canAudit && <LeaderTelegramCard />}
      {/* the clinic's own AI allowance field: only for a clinic without the Payment tab (the demo) */}
      {canAudit && !canPay && <AiLimitCard />}
      {canAudit && <AiGeneralSettings />}

      {canAudit && <ClinicContacts />}
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
      </div>
      )}
    </>
  );
}
