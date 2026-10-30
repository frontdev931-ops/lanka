'use client';

import type { ReactNode } from 'react';
import { useT } from '../lib/i18n';

const ICONS: Record<string, string[]> = {
  phone: ['M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z'],
  clock: ['M12 7v5l3 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
  home: ['M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  chart: ['M12 20V10', 'M18 20V4', 'M6 20v-4'],
  sparkles: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z'],
  check: ['M9 11l3 3L22 4', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'],
  zap: ['M13 2L3 14h9l-1 8 10-12h-9z'],
  card: ['M3 6h18v12H3z', 'M3 10h18'],
  message: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  star: ['M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z'],
  trend: ['M23 6l-9.5 9.5-5-5L1 18', 'M17 6h6v6'],
  plug: ['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v5a6 6 0 0 1-12 0V8z'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M4 12h2', 'M18 12h2', 'M12 4v2', 'M12 18v2', 'M6.3 6.3l1.4 1.4', 'M16.3 16.3l1.4 1.4', 'M17.7 6.3l-1.4 1.4', 'M7.7 16.3l-1.4 1.4'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  menu: ['M3 12h18', 'M3 6h18', 'M3 18h18'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  refresh: ['M23 4v6h-6', 'M1 20v-6h6', 'M3.5 9a9 9 0 0 1 14.9-3.4L23 10', 'M1 14l4.6 4.4A9 9 0 0 0 20.5 15'],
  plus: ['M12 5v14', 'M5 12h14'],
  back: ['M19 12H5', 'M12 19l-7-7 7-7'],
  next: ['M5 12h14', 'M12 5l7 7-7 7'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  close: ['M18 6L6 18', 'M6 6l12 12'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
  userx: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M17 8l5 5', 'M22 8l-5 5'],
};

export function Icon({ name, size = 18 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {(ICONS[name] ?? []).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="toolbar">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, flush }: { title?: string; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={`card${flush ? ' flush' : ''}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="toolbar">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export type Tone = 'green' | 'red' | 'amber' | 'blue' | 'teal' | 'gray';

export function Badge({ tone = 'gray', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone === 'gray' ? '' : tone}`}>{children}</span>;
}

// Цвет бейджа по статусу записи в Cliniccards
export function statusTone(status: string): Tone {
  switch (status) {
    case 'VISITED':
      return 'green';
    case 'CONFIRMED':
    case 'PLANNED':
    case 'BOOKING':
      return 'blue';
    case 'IN_CLINIC':
    case 'IN_CHAIR':
      return 'teal';
    case 'NOT_CONFIRMED':
    case 'MOVED':
      return 'amber';
    case 'DID_NOT_COME':
    case 'CANCELLED':
      return 'red';
    default:
      return 'gray';
  }
}

export function resultTone(result: string | null): Tone {
  if (result === 'BOOKED') return 'green';
  if (result === 'DECLINED') return 'red';
  if (result === 'NO_ANSWER' || result === 'CALL_LATER') return 'amber';
  return 'gray';
}

export function Alert({ tone, children }: { tone: 'error' | 'success' | 'warn' | 'info'; children: ReactNode }) {
  return <div className={`alert ${tone}`}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

export function Loading({ children }: { children?: ReactNode }) {
  const t = useT();
  return (
    <div className="loading">
      <span className="spinner" />
      {children ?? t('common.loading')}
    </div>
  );
}
