'use client';

import { ReactNode, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, isUnauthorized, logout } from '../lib/api';
import { Key, useI18n } from '../lib/i18n';
import { initials } from '../lib/ui';
import { Alert, Icon } from './ui';
import LanguageSwitcher from './LanguageSwitcher';
import { Brand } from './Brand';
import { VerifyBanner } from './VerifyBanner';
import { InstallApp } from './InstallApp';
import { AcceptTermsGate } from './Terms';
import { ProfileDialog } from './ProfileDialog';
import { ThemeSwitch, useTheme } from './ThemeSwitch';

// also: the other pages of the same section (the item stays highlighted on them)
type NavItem = { href: string; label: Key; icon: string; also?: string[] };

// Sections by what the person came to do (Signals became an item of its own on 2026-11-23). Pages that used to be separate items are tabs of a section now (SECTIONS below); their addresses did not change.
const NAV: (NavItem | { sep: true })[] = [
  { href: '/dashboard', label: 'nav.home', icon: 'home' },
  // the patient funnel is a product of its own: a first-level item, not a tab of the reports
  { href: '/analytics', label: 'nav.funnel', icon: 'trend' },
  { href: '/inbox', label: 'nav.inbox', icon: 'message' },
  { href: '/automations', label: 'nav.outgoing', icon: 'zap', also: ['/my-automations'] },
  { href: '/patients', label: 'nav.patients', icon: 'users', also: ['/inquiries', '/waitlist', '/imports'] },
  { href: '/tasks', label: 'nav.tasks', icon: 'check' },
  { href: '/reports', label: 'nav.reportsAll', icon: 'chart', also: ['/quality', '/insights', '/payback', '/ads', '/period-report'] },
  // deviations in the clinic's work: an item of its own next to the reports (owner and manager), with the number of fired signals
  { href: '/signals', label: 'sec.signals', icon: 'alert' },
  { href: '/knowledge', label: 'nav.aiAdmin', icon: 'sparkles', also: ['/ai-admin'] },
  { sep: true },
  { href: '/settings', label: 'nav.settings', icon: 'settings' },
];

// The tabs of a section, shown above the page on exactly these addresses (not on a patient's card or in the report builder). only: the roles that may open the tab.
// needs: 'network' = shown only to a member of a network of clinics
type SectionTab = { href: string; label: Key; only?: string[]; needs?: 'network' };
const LEAD = ['OWNER', 'MANAGER'];
const SECTIONS: { label: Key; tabs: SectionTab[] }[] = [
  { label: 'nav.patients', tabs: [{ href: '/patients', label: 'sec.cards' }, { href: '/inquiries', label: 'nav.inquiries' }, { href: '/waitlist', label: 'nav.waitlist' }] },
  { label: 'nav.reportsAll', tabs: [{ href: '/reports', label: 'nav.reports' }, { href: '/quality', label: 'nav.quality' }, { href: '/payback', label: 'sec.payback', only: LEAD }, { href: '/ads', label: 'sec.ads', only: ['OWNER', 'MANAGER', 'ANALYST'] }, { href: '/period-report', label: 'sec.periodReport', only: LEAD }, { href: '/insights', label: 'sec.scheduled', only: LEAD }, { href: '/network', label: 'sec.network', needs: 'network' }] },
  { label: 'nav.aiAdmin', tabs: [{ href: '/knowledge', label: 'nav.knowledge' }, { href: '/ai-admin', label: 'sec.mode', only: LEAD }, { href: '/ai-admin/booking', label: 'sec.booking', only: LEAD }, { href: '/ai-admin/follow-ups', label: 'sec.followups', only: ['OWNER', 'MANAGER', 'ADMIN'] }] },
];

// Only for the owner of the service (see PLATFORM_ADMIN_EMAILS)
const PLATFORM_ITEM: NavItem = { href: '/platform', label: 'nav.platform', icon: 'chart' };

// The bottom bar on a phone: the main things under the thumb, the rest under "More"
const TABS: NavItem[] = [
  { href: '/dashboard', label: 'nav.home', icon: 'home' },
  { href: '/patients', label: 'nav.patients', icon: 'users' },
  { href: '/reports', label: 'nav.reports', icon: 'chart' },
  { href: '/tasks', label: 'nav.tasks', icon: 'check' },
];

interface Me {
  name: string;
  email?: string;
  pendingEmail?: string | null;
  role: string;
  clinicId?: string;
  clinicName: string;
  clinicLogo?: string | null;
  avatar?: string | null;
  emailVerified?: boolean;
  termsAccepted?: boolean;
  twoFactorRequired?: boolean;
  suspended?: boolean;
  platformAdmin?: boolean;
  billing?: { status: string; plan: string; paidUntil: string | null; graceDays: number; demo: boolean; blocked: boolean };
}

// On narrow screens tables turn into cards: each cell's label comes from the column header.
// We do it with one observer, so that any table (including a future one) works on a phone without extra work.
function useStackedTables() {
  useEffect(() => {
    let frame = 0;
    const label = () => {
      document.querySelectorAll('table.table').forEach((table) => {
        const heads = [...table.querySelectorAll('thead th')].map((h) => h.textContent?.trim() ?? '');
        table.querySelectorAll('tbody tr').forEach((tr) => {
          [...tr.children].forEach((td, i) => {
            if (td.getAttribute('data-label') !== heads[i]) td.setAttribute('data-label', heads[i] ?? '');
          });
        });
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(label);
    };
    label();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
}

export default function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const { t, label } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  const [newRequests, setNewRequests] = useState(0);
  // switched-on signals with a deviation now (GET /signals/summary); null = not known (no access, not in the plan, not loaded): no badge
  const [signalsFired, setSignalsFired] = useState<number | null>(null);
  const [aiLimit, setAiLimit] = useState(false);
  const [assistantInPlan, setAssistantInPlan] = useState(false);
  // the person's clinics (a network's branches, or several clinics): the switcher in the user box; a member of a network gets the "Network" tab
  const [clinics, setClinics] = useState<{ id: string; name: string; role: string }[]>([]);
  const [inNetwork, setInNetwork] = useState(false);
  // most of the monthly AI allowance is used and nothing is bought: a notice in advance (closed for this browser session with the cross)
  const [aiLow, setAiLow] = useState<{ used: number; limit: number } | null>(null);
  const [theme, setTheme] = useTheme();
  useStackedTables();

  // The session is stored in an httpOnly cookie: the only way to know whether the user is signed in is to ask the server
  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch((e) => {
        // a lapsed session: sign in, then back to this very page (a notification's link keeps working)
        if (isUnauthorized(e)) router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      });
  }, [router]);

  useEffect(() => {
    if (!me) return;
    api<{ id: string; name: string; role: string }[]>('/auth/clinics').then(setClinics).catch(() => {});
    api<unknown[]>('/billing/networks').then((n) => setInNetwork(n.length > 0)).catch(() => {});
  }, [me]);
  const switchClinic = async (clinicId: string) => {
    await api('/auth/switch', { method: 'POST', body: JSON.stringify({ clinicId }) });
    window.location.href = '/dashboard';
  };

  // The Cliniccards card in Settings reports that the data load is finished: the clinic's logo may have changed
  useEffect(() => {
    const refresh = () => {
      api<Me>('/auth/me').then(setMe).catch(() => {});
    };
    window.addEventListener('stomat:me-changed', refresh);
    return () => window.removeEventListener('stomat:me-changed', refresh);
  }, []);

  // The number of new requests to the administrator (from conversations): shown as a badge on the "Messages" item; the section is unavailable to a doctor
  useEffect(() => {
    // a clinic locked by billing (unpaid, lapsed) cannot read requests: no badge and no request that would be refused
    if (!me || me.role === 'DOCTOR' || me.billing?.blocked) return;
    const load = () => api<{ newCount: number }>('/requests?status=NEW').then((r) => setNewRequests(r.newCount)).catch(() => {});
    load();
    const id = setInterval(load, 30000);
    window.addEventListener('stomat:requests-changed', load);
    return () => {
      clearInterval(id);
      window.removeEventListener('stomat:requests-changed', load);
    };
  }, [me]);

  // The badge of "Signals": the number of switched-on rules with a deviation, for the owner and the manager (the server refuses other roles, a clinic
  // locked by billing reads nothing). Asked when the person or the clinic changes, after the Signals page measured or saved, and after a Cliniccards
  // load; no polling: the server keeps the measurement a few minutes. A failed request keeps the last known number, never a made-up zero.
  useEffect(() => {
    setSignalsFired(null);
    if (!me || (me.role !== 'OWNER' && me.role !== 'MANAGER') || me.billing?.blocked || me.suspended) return;
    let alive = true;
    const load = () =>
      api<{ inPlan: boolean; fired?: number }>('/signals/summary')
        .then((r) => alive && setSignalsFired(r.inPlan && typeof r.fired === 'number' ? r.fired : null))
        .catch(() => undefined);
    void load();
    window.addEventListener('stomat:signals-changed', load);
    window.addEventListener('stomat:me-changed', load);
    return () => {
      alive = false;
      window.removeEventListener('stomat:signals-changed', load);
      window.removeEventListener('stomat:me-changed', load);
    };
  }, [me?.clinicId, me?.role, me?.billing?.blocked, me?.suspended]); // eslint-disable-line react-hooks/exhaustive-deps

  // The shared monthly AI allowance is used up: a notice for the owner and the manager on every page (the live state of the server, so it works without
  // Telegram and disappears by itself after a top-up or in a new period). Asked again on every page change; shown only where an AI feature is on.
  useEffect(() => {
    if (!me || me.role === 'DOCTOR' || me.billing?.blocked || me.suspended) return;
    const lead = me.role === 'OWNER' || me.role === 'MANAGER';
    api<{ available: boolean; enabled: boolean; assistant: boolean; assistantInPlan?: boolean; limitReached?: boolean; used: number; monthlyLimit: number; purchased: number }>('/ai')
      .then((a) => {
        // the manager's assistant is a Pro feature: without it the pinned button is not shown at all
        setAssistantInPlan(a.assistantInPlan !== false);
        if (!lead) return;
        const on = a.available && (a.enabled || a.assistant);
        setAiLimit(on && !!a.limitReached);
        let closed = false;
        try {
          closed = window.sessionStorage.getItem('stomat_ai_low_closed') === '1';
        } catch {
          // no storage: the notice simply stays
        }
        setAiLow(on && !a.limitReached && !closed && a.purchased <= 0 && a.monthlyLimit > 0 && a.used >= a.monthlyLimit * 0.8 ? { used: a.used, limit: a.monthlyLimit } : null);
      })
      .catch(() => {});
  }, [me, path]);

  // The owner's "require two-factor" rule sends users without it to settings.
  useEffect(() => {
    if (!me) return;
    if (me.twoFactorRequired && !path.startsWith('/settings')) router.replace('/settings');
    // Real data opens after payment: until then the only page is the payment tab of Settings (the settings page shows only that tab then)
    // a branch of an unpaid network is paid on the network page, which therefore stays open too
    else if (me.billing?.blocked && !path.startsWith('/settings') && !path.startsWith('/network')) router.replace('/settings?tab=billing');
  }, [me, path, router]);

  const [profile, setProfile] = useState(false);
  useEffect(() => setOpen(false), [path]);

  const closeProfile = useCallback(() => setProfile(false), []);

  async function signOut() {
    await logout();
    router.push('/login');
  }

  const isActive = (href: string) => path.startsWith(href);
  const inSection = (n: NavItem) => [n.href, ...(n.also ?? [])].some(isActive);
  const moreActive = open || !TABS.some((x) => isActive(x.href));
  const section = SECTIONS.find((s) => s.tabs.some((x) => x.href === path));
  // "Ask AI" (the manager's assistant over the clinic's data) is a button pinned on every page instead of a sidebar item. Not for a doctor (the server
  // refuses the role), not on its own page, and not in the inbox, where it would cover the reply field on a phone.
  const askAi = !!me && assistantInPlan && me.role !== 'DOCTOR' && !me.suspended && !me.billing?.blocked && !path.startsWith('/assistant') && !path.startsWith('/inbox');
  const sectionTabs = section?.tabs.filter((x) => (!x.only || (me && x.only.includes(me.role))) && (x.needs !== 'network' || inNetwork)) ?? [];

  return (
    <div className="app">
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="sidebar-top">
          <Link href="/dashboard" className="brand">
            <Brand />
          </Link>
          {/* the phone's header: the theme as one icon (on a computer it is in the top bar) */}
          <span className="phone-only"><ThemeSwitch theme={theme} onChange={setTheme} compact /></span>
        </div>

        <nav className="nav">
          {(me?.platformAdmin ? [...NAV, PLATFORM_ITEM] : NAV)
            .filter((n) => 'sep' in n || n.href !== '/knowledge' || me?.role === 'OWNER' || me?.role === 'MANAGER' || me?.role === 'ADMIN')
            // Signals: the owner and the manager only (the same roles as the server's)
            .filter((n) => 'sep' in n || n.href !== '/signals' || me?.role === 'OWNER' || me?.role === 'MANAGER')
            .map((n, i) =>
            'sep' in n ? (
              <div key={i} className="nav-sep" />
            ) : (
              <Link key={n.href} href={n.href} className={`nav-item${inSection(n) ? ' active' : ''}`}>
                <Icon name={n.icon} />
                {t(n.label)}
                {n.href === '/inbox' && newRequests > 0 && <span className="nav-badge" aria-label={`${newRequests}`}>{newRequests}</span>}
                {n.href === '/signals' && !!signalsFired && <span className="nav-badge" role="status" aria-label={t('nav.signalsBadge', { n: signalsFired })} title={t('nav.signalsBadge', { n: signalsFired })}>{signalsFired}</span>}
              </Link>
            ),
          )}
        </nav>

        <div className="user-box">
          <div className="phone-only"><LanguageSwitcher /></div>
          <InstallApp />
          <button type="button" className="user-line user-line-btn" onClick={() => setProfile(true)} aria-haspopup="dialog" title={t('prof.open')}>
            {me?.avatar ? (
              <img className="avatar avatar-logo" src={me.avatar} alt="" />
            ) : me?.clinicLogo ? (
              <img className="avatar avatar-logo" src={me.clinicLogo} alt="" />
            ) : (
              <span className="avatar">{initials(me?.name)}</span>
            )}
            <div className="user-meta">
              <b>{me?.name ?? '…'}</b>
              <span>{me?.clinicName ?? ''}</span>
              <span>{me ? label('role', me.role) : ''}</span>
            </div>
          </button>
          {clinics.length > 1 && me && (
            <label className="field clinic-switch phone-only">
              <span>{t('net.switch')}</span>
              <select className="input" value={me.clinicId ?? ''} onChange={(e) => void switchClinic(e.target.value)}>
                {clinics.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          )}
          <button className="btn btn-sm" onClick={signOut}>
            <Icon name="logout" size={15} /> {t('common.logout')}
          </button>
        </div>
      </aside>
      {profile && <ProfileDialog onClose={closeProfile} />}

      <div className="main-col">
      {/* The top bar on a computer (design of 2026-11-23): the clinic, the language, the theme and "Ask AI"; on a phone they live in the menu and the header */}
      <header className="topbar">
        {clinics.length > 1 && me ? (
          <label className="topbar-clinic">
            <span>{t('net.switch')}</span>
            <select className="input" value={me.clinicId ?? ''} onChange={(e) => void switchClinic(e.target.value)}>
              {clinics.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <span className="topbar-name">{me?.clinicName ?? ''}</span>
        )}
        <span className="topbar-gap" />
        <LanguageSwitcher compact />
        <ThemeSwitch theme={theme} onChange={setTheme} />
        {askAi && (
          <Link href="/assistant" className="topbar-ai">
            <Icon name="sparkles" size={16} />
            {t('sec.askAi')}
          </Link>
        )}
      </header>
      <main className={`content${askAi ? ' with-ask' : ''}`}>
        {me && me.role === 'OWNER' && me.termsAccepted === false && <AcceptTermsGate onAccepted={() => setMe({ ...me, termsAccepted: true })} />}
        {me && me.emailVerified === false && <VerifyBanner />}
        {me?.billing?.demo && <Alert tone="info">{t('demo.banner')} <Link href="/login?register=1">{t('demo.connect')}</Link></Alert>}
        {me?.twoFactorRequired && <Alert tone="warn">{t('twofa.requiredBanner')}</Alert>}
        {me?.billing?.status === 'PAST_DUE' && !me.billing.blocked && <Alert tone="warn">{t('billing.pastDueBanner', { days: me.billing.graceDays })} <a href="/settings?tab=billing">{t('billing.pay')}</a></Alert>}
        {/* the limit is managed in Payment; a demo clinic has no Payment tab, its limit field is in General */}
        {aiLimit && !me?.suspended && <Alert tone="warn">{t('ailimit.banner')} <a href={me?.billing?.demo ? '/settings' : '/settings?tab=billing'}>{t(me?.billing?.demo ? 'ailimit.toGeneral' : 'ailimit.toBilling')}</a></Alert>}
        {aiLow && !aiLimit && !me?.suspended && (
          <Alert tone="info">
            {t('ailimit.low', { used: aiLow.used, limit: aiLow.limit })}{' '}
            <a href={me?.billing?.demo ? '/settings' : '/settings?tab=billing'}>{t(me?.billing?.demo ? 'ailimit.toGeneral' : 'ailimit.toBilling')}</a>{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setAiLow(null);
                try {
                  window.sessionStorage.setItem('stomat_ai_low_closed', '1');
                } catch {
                  // closed only until the next page
                }
              }}
            >
              {t('ailimit.close')}
            </button>
          </Alert>
        )}
        {me?.suspended ? (
          <div className="card" style={{ padding: 24, textAlign: 'center' }}>
            <h2 style={{ marginTop: 0 }}>{t('nav.suspendedTitle')}</h2>
            <p className="muted">{t('nav.suspendedText')}</p>
          </div>
        ) : (
          <>
            {section && sectionTabs.length > 1 && (
              <nav className="line-tabs section-tabs" aria-label={t(section.label)}>
                {sectionTabs.map((x) => (
                  <Link key={x.href} href={x.href} className={`line-tab${x.href === path ? ' active' : ''}`} aria-current={x.href === path ? 'page' : undefined}>
                    {t(x.label)}
                  </Link>
                ))}
              </nav>
            )}
            {children}
          </>
        )}
      </main>
      </div>

      {askAi && (
        <Link href="/assistant" className="ask-ai" aria-label={t('sec.askAi')} title={t('sec.askAi')}>
          <Icon name="sparkles" size={20} />
          <span>{t('sec.askAi')}</span>
        </Link>
      )}

      <nav className="tabbar" aria-label={t('nav.menu')}>
        {TABS.map((x) => (
          <Link key={x.href} href={x.href} className={`tab-item${isActive(x.href) && !open ? ' active' : ''}`}>
            <Icon name={x.icon} size={22} />
            {t(x.label)}
          </Link>
        ))}
        <button type="button" className={`tab-item${moreActive ? ' active' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? 'close' : 'menu'} size={22} />
          {t('nav.more')}
        </button>
      </nav>
    </div>
  );
}
