'use client';

import { ReactNode, useEffect, useState } from 'react';
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

type NavItem = { href: string; label: Key; icon: string };

const NAV: (NavItem | { sep: true })[] = [
  { href: '/dashboard', label: 'nav.home', icon: 'home' },
  { href: '/patients', label: 'nav.patients', icon: 'users' },
  { href: '/reports', label: 'nav.reports', icon: 'chart' },
  { href: '/tasks', label: 'nav.tasks', icon: 'check' },
  { href: '/inquiries', label: 'nav.inquiries', icon: 'phone' },
  { href: '/imports', label: 'nav.imports', icon: 'upload' },
  { sep: true },
  { href: '/assistant', label: 'nav.assistant', icon: 'sparkles' },
  { href: '/knowledge', label: 'nav.knowledge', icon: 'check' },
  { href: '/automations', label: 'nav.automations', icon: 'zap' },
  { href: '/my-automations', label: 'nav.myAutomations', icon: 'sparkles' },
  { href: '/inbox', label: 'nav.inbox', icon: 'message' },
  { href: '/waitlist', label: 'nav.waitlist', icon: 'users' },
  { href: '/quality', label: 'nav.quality', icon: 'star' },
  { href: '/analytics', label: 'nav.analytics', icon: 'trend' },
  { href: '/insights', label: 'nav.insights', icon: 'zap' },
  { sep: true },
  { href: '/integrations', label: 'nav.integrations', icon: 'plug' },
  { href: '/billing', label: 'nav.billing', icon: 'card' },
  { href: '/settings', label: 'nav.settings', icon: 'settings' },
];

// Only for the owner of the service (see PLATFORM_ADMIN_EMAILS)
const PLATFORM_ITEM: NavItem = { href: '/platform', label: 'nav.platform', icon: 'chart' };

// Нижняя панель на телефоне: главное под большим пальцем, остальное под «Ещё»
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
  clinicName: string;
  clinicLogo?: string | null;
  emailVerified?: boolean;
  termsAccepted?: boolean;
  twoFactorRequired?: boolean;
  suspended?: boolean;
  platformAdmin?: boolean;
  billing?: { status: string; plan: string; paidUntil: string | null; graceDays: number; demo: boolean; blocked: boolean };
}

// На узких экранах таблицы превращаются в карточки: подпись каждой ячейки берётся из заголовка колонки.
// Делаем это одним наблюдателем, чтобы любая таблица (в том числе будущая) работала на телефоне без доработок.
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
  useStackedTables();

  // Сессия хранится в httpOnly-cookie: единственный способ узнать, вошёл ли пользователь, — спросить сервер
  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch((e) => {
        if (isUnauthorized(e)) router.replace('/login');
      });
  }, [router]);

  // Страница интеграций сообщает, что загрузка данных закончилась: логотип клиники мог измениться
  useEffect(() => {
    const refresh = () => {
      api<Me>('/auth/me').then(setMe).catch(() => {});
    };
    window.addEventListener('stomat:me-changed', refresh);
    return () => window.removeEventListener('stomat:me-changed', refresh);
  }, []);

  // Число новых заявок администратору (из переписки): показывается значком у пункта «Листування»; врачу раздел недоступен
  useEffect(() => {
    if (!me || me.role === 'DOCTOR') return;
    const load = () => api<{ newCount: number }>('/requests?status=NEW').then((r) => setNewRequests(r.newCount)).catch(() => {});
    load();
    const id = setInterval(load, 30000);
    window.addEventListener('stomat:requests-changed', load);
    return () => {
      clearInterval(id);
      window.removeEventListener('stomat:requests-changed', load);
    };
  }, [me]);

  // The owner's "require two-factor" rule sends users without it to settings.
  useEffect(() => {
    if (!me) return;
    if (me.twoFactorRequired && !path.startsWith('/settings')) router.replace('/settings');
    // Real data opens after payment: until then the only page is the payment page
    else if (me.billing?.blocked && !path.startsWith('/billing')) router.replace('/billing');
  }, [me, path, router]);

  useEffect(() => setOpen(false), [path]);

  async function signOut() {
    await logout();
    router.push('/login');
  }

  const isActive = (href: string) => path.startsWith(href);
  const moreActive = open || !TABS.some((x) => isActive(x.href));

  return (
    <div className="app">
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="sidebar-top">
          <Link href="/dashboard" className="brand">
            <Brand />
          </Link>
        </div>

        <nav className="nav">
          {(me?.platformAdmin ? [...NAV, PLATFORM_ITEM] : NAV)
            .filter((n) => 'sep' in n || n.href !== '/my-automations' || me?.role === 'OWNER' || me?.role === 'MANAGER')
            .filter((n) => 'sep' in n || n.href !== '/insights' || me?.role === 'OWNER' || me?.role === 'MANAGER')
            .filter((n) => 'sep' in n || n.href !== '/knowledge' || me?.role === 'OWNER' || me?.role === 'MANAGER' || me?.role === 'ADMIN')
            .filter((n) => 'sep' in n || n.href !== '/billing' || ((me?.role === 'OWNER' || me?.role === 'MANAGER') && !me?.billing?.demo))
            .map((n, i) =>
            'sep' in n ? (
              <div key={i} className="nav-sep" />
            ) : (
              <Link key={n.href} href={n.href} className={`nav-item${isActive(n.href) ? ' active' : ''}`}>
                <Icon name={n.icon} />
                {t(n.label)}
                {n.href === '/inbox' && newRequests > 0 && <span className="nav-badge" aria-label={`${newRequests}`}>{newRequests}</span>}
              </Link>
            ),
          )}
        </nav>

        <div className="user-box">
          <LanguageSwitcher />
          <InstallApp />
          <div className="user-line">
            {me?.clinicLogo ? (
              <img className="avatar avatar-logo" src={me.clinicLogo} alt="" />
            ) : (
              <span className="avatar">{initials(me?.name)}</span>
            )}
            <div className="user-meta">
              <b>{me?.name ?? '…'}</b>
              <span>{me?.clinicName ?? ''}</span>
              <span>{me ? label('role', me.role) : ''}</span>
            </div>
          </div>
          <button className="btn btn-sm" onClick={signOut}>
            <Icon name="logout" size={15} /> {t('common.logout')}
          </button>
        </div>
      </aside>

      <main className="content">
        {me && me.role === 'OWNER' && me.termsAccepted === false && <AcceptTermsGate onAccepted={() => setMe({ ...me, termsAccepted: true })} />}
        {me && me.emailVerified === false && <VerifyBanner />}
        {me?.billing?.demo && <Alert tone="info">{t('demo.banner')} <Link href="/login?register=1">{t('demo.connect')}</Link></Alert>}
        {me?.twoFactorRequired && <Alert tone="warn">{t('twofa.requiredBanner')}</Alert>}
        {me?.billing?.status === 'PAST_DUE' && !me.billing.blocked && <Alert tone="warn">{t('billing.pastDueBanner', { days: me.billing.graceDays })} <Link href="/billing">{t('billing.pay')}</Link></Alert>}
        {me?.suspended ? (
          <div className="card" style={{ padding: 24, textAlign: 'center' }}>
            <h2 style={{ marginTop: 0 }}>{t('nav.suspendedTitle')}</h2>
            <p className="muted">{t('nav.suspendedText')}</p>
          </div>
        ) : (
          children
        )}
      </main>

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
