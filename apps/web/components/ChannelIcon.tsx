import { useId } from 'react';
import type { ChannelIconKey } from '../lib/landing-text';

// Simple marks of the channels for the landing page, drawn here (no image files, no external requests). The messengers get their usual colours so a
// visitor recognises them at a glance; Cliniccards gets a neutral mark of a patient record in LANKA's colour (we do not imitate its logo).
const TITLE: Record<ChannelIconKey, string> = { cliniccards: 'Cliniccards', telegram: 'Telegram', instagram: 'Instagram', messenger: 'Facebook Messenger', email: 'Email' };

export function ChannelIcon({ name, size = 40 }: { name: ChannelIconKey; size?: number }) {
  // gradient ids are unique per icon: the same channel may be drawn twice on a page
  const uid = useId().replace(/:/g, '');
  const common = { width: size, height: size, viewBox: '0 0 40 40', role: 'img' as const, 'aria-label': TITLE[name], className: 'channel-icon' };
  switch (name) {
    case 'telegram':
      return (
        <svg {...common}>
          <circle cx="20" cy="20" r="20" fill="#229ED9" />
          <path d="M9.2 19.4l18.6-7.2c.9-.3 1.6.2 1.3 1.6l-3.2 15c-.2 1.1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.2-8.3c.4-.4-.1-.6-.6-.2l-11.4 7.2-4.9-1.5c-1.1-.3-1.1-1.1.8-1.6z" fill="#fff" />
        </svg>
      );
    case 'instagram':
      return (
        <svg {...common}>
          <defs>
            <linearGradient id={`ig${uid}`} x1="0" y1="40" x2="40" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#FEDA75" />
              <stop offset="0.35" stopColor="#FA7E1E" />
              <stop offset="0.6" stopColor="#D62976" />
              <stop offset="1" stopColor="#4F5BD5" />
            </linearGradient>
          </defs>
          <rect width="40" height="40" rx="11" fill={`url(#ig${uid})`} />
          <rect x="10" y="10" width="20" height="20" rx="6" fill="none" stroke="#fff" strokeWidth="2.4" />
          <circle cx="20" cy="20" r="4.6" fill="none" stroke="#fff" strokeWidth="2.4" />
          <circle cx="26.2" cy="13.8" r="1.5" fill="#fff" />
        </svg>
      );
    case 'messenger':
      return (
        <svg {...common}>
          <defs>
            <linearGradient id={`ms${uid}`} x1="20" y1="40" x2="20" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#0068FF" />
              <stop offset="1" stopColor="#A033FF" />
            </linearGradient>
          </defs>
          <circle cx="20" cy="20" r="20" fill={`url(#ms${uid})`} />
          <path d="M20 9c-6.3 0-11 4.6-11 10.6 0 3.3 1.5 6.1 3.8 8v3.7l3.5-1.9c1.2.3 2.4.5 3.7.5 6.3 0 11-4.6 11-10.6S26.3 9 20 9z" fill="#fff" />
          <path d="M13.6 22.9l3.6-5.7 3 2.3 4.3-2.4-3.6 5.7-3-2.3z" fill="#5A3FFF" />
        </svg>
      );
    case 'email':
      return (
        <svg {...common}>
          <rect width="40" height="40" rx="11" fill="#E8EEF3" />
          <rect x="9" y="12" width="22" height="16" rx="3" fill="none" stroke="#3A4A57" strokeWidth="2.2" />
          <path d="M10 14l10 7 10-7" fill="none" stroke="#3A4A57" strokeWidth="2.2" strokeLinejoin="round" />
        </svg>
      );
    case 'cliniccards':
      return (
        <svg {...common}>
          <rect width="40" height="40" rx="11" fill="var(--primary-soft, #e2f5f5)" />
          <rect x="10" y="9" width="20" height="23" rx="3" fill="none" stroke="var(--primary-dark, #0a7c81)" strokeWidth="2.2" />
          <path d="M15 16h10M15 21h10M15 26h6" stroke="var(--primary-dark, #0a7c81)" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
  }
}
