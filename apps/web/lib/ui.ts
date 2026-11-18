import { intlLocale } from './i18n';

// Date formats depend on the chosen language; the components that call them are redrawn when the language changes
export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString(intlLocale()) : '—');
export const fmtDateTime = (s?: string | null) =>
  s ? new Date(s).toLocaleString(intlLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtNumber = (n: number | string) => Number(n).toLocaleString(intlLocale());
// A sum in a known unit: LANKA's own prices (always hryvnias). unit: the short word of the language ("грн").
export const fmtMoney = (n: number | string, unit: string) => `${fmtNumber(Math.round(Number(n)))} ${unit}`;

// Money from the clinic's Cliniccards comes with the currency stamp the server gives it (apps/api/src/common/money.ts): a code, or null when the clinic's
// owner has not stated the currency. Several currencies are never added up: a total is a list, one entry per currency.
export interface MoneyTotal {
  currency: string | null;
  amount: number;
}
// uah: the word for hryvnias in the language; unknown: "валюта не підтверджена"
export const fmtAmount = (n: number | string, code: string | null, uah: string, unknown: string) =>
  `${fmtNumber(Math.round(Number(n)))} ${code ? (code === 'UAH' ? uah : code) : `(${unknown})`}`;
export const fmtTotals = (list: MoneyTotal[] | null | undefined, uah: string, unknown: string) =>
  list && list.length ? list.map((x) => fmtAmount(x.amount, x.currency, uah, unknown)).join('; ') : '0';
// The "Currency" cell of a report: the code, "currency?" when not confirmed, "several" for a row with amounts in more than one currency
export const currencyCell = (v: unknown, unknownShort: string, several: string) => (v === 'MIXED' ? several : typeof v === 'string' && v ? v : unknownShort);

export const initials = (name?: string) =>
  (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';
