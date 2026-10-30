import { intlLocale } from './i18n';

// Форматы дат зависят от выбранного языка; компоненты, которые их вызывают, перерисовываются при смене языка
export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString(intlLocale()) : '—');
export const fmtDateTime = (s?: string | null) =>
  s ? new Date(s).toLocaleString(intlLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtNumber = (n: number | string) => Number(n).toLocaleString(intlLocale());

export const initials = (name?: string) =>
  (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';
