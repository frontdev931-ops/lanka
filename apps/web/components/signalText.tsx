'use client';

import { Fragment, ReactNode } from 'react';
import { Key } from '../lib/i18n';
import { fmtDate, fmtDateTime } from '../lib/ui';

// The current result of a signal in words: one sentence for the card and the details page, and its dates and secondary numbers. The same
// sentences in both places, from the same measurement of GET /signals and GET /signals/:kind.
export type State = 'fired' | 'ok' | 'insufficient' | 'needs_sync' | 'never' | 'not_connected' | 'off';
export type Kind = 'CANCEL_RATE' | 'NO_REBOOK' | 'OVERDUE_TASKS' | 'PAYMENTS_DROP' | 'RETURN_DROP' | 'STALE_REQUESTS' | 'SYNC_OVERDUE' | 'UNFINISHED_NO_NEXT';
export interface Signal {
  kind: Kind;
  state: State;
  // the master switch (off: not measured, nothing delivered on any channel; the channel preferences are kept)
  active: boolean;
  threshold: number;
  windowDays: number;
  hours: number;
  limits: { threshold: [number, number]; windowDays: [number, number] | null; hours: [number, number] | null };
  telegramOn: boolean;
  emailOn: boolean;
  pushOn: boolean;
  lastFiredAt: string | null;
  telegramSentAt: string | null;
  // null: the signal shows its own comparison (no report substantiates it)
  link: string | null;
  value?: number;
  count?: number;
  base?: number;
  need?: number;
  reason?: 'currency';
  from?: string;
  to?: string;
  prevFrom?: string;
  prevTo?: string;
  amount?: number;
  prevAmount?: number;
  currency?: string;
  oldestDays?: number;
  lookbackDays?: number;
  lastSyncAt?: string;
}

type T = (key: Key, vars?: Record<string, string | number>) => string;
// "**x**" in a translated sentence marks the number that matters
export const rich = (text: string): ReactNode => text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : <Fragment key={i}>{part}</Fragment>));
// a period's end is exclusive (the start of the next day): show the last day it covers
const lastDay = (iso: string) => fmtDate(new Date(Date.parse(iso) - 1).toISOString());

export function signalText(s: Pick<Signal, 'kind' | 'state' | 'value' | 'count' | 'base' | 'need' | 'reason' | 'from' | 'to' | 'prevFrom' | 'prevTo' | 'amount' | 'prevAmount' | 'currency' | 'oldestDays' | 'lastSyncAt' | 'hours' | 'windowDays'>, t: T) {
  const unit = (c?: string) => (c === 'UAH' ? t('billing.uah') : c ?? '');
  const period = (a?: string, b?: string) => (a && b ? `${fmtDate(a)} — ${lastDay(b)}` : '');
  // the current result in one short sentence (the number that matters in bold); dates and secondary numbers go to the details
  const what = (): string => {
    if (s.state === 'needs_sync') return t('sig.needsSync');
    if (s.state === 'never') return t('sig.SYNC_OVERDUE.never');
    if (s.state === 'not_connected') return t('sig.SYNC_OVERDUE.notConnected');
    if (s.state === 'insufficient') {
      if (s.reason === 'currency') return t('sig.PAYMENTS_DROP.currency');
      if (s.kind === 'RETURN_DROP' || s.kind === 'PAYMENTS_DROP') return t(`sig.${s.kind}.insufficient` as Key, { n: s.base ?? 0, need: s.need ?? 0, period: period(s.from, s.to) });
      return t('sig.insufficient', { n: s.base ?? 0, need: s.need ?? 0, period: period(s.from, s.to) });
    }
    const v2 = s.value ?? 0;
    const dir = v2 > 0 ? 'less' : v2 < 0 ? 'more' : 'same';
    switch (s.kind) {
      case 'CANCEL_RATE':
        return t('sig.CANCEL_RATE.what', { v: v2, n: s.count ?? 0, total: s.base ?? 0 });
      case 'RETURN_DROP':
        return t(`sig.RETURN_DROP.${dir}` as Key, { cur: s.count ?? 0, prev: s.base ?? 0, v: Math.abs(v2) });
      case 'PAYMENTS_DROP':
        return t(`sig.PAYMENTS_DROP.${dir}` as Key, { cur: (s.amount ?? 0).toLocaleString(), prev: (s.prevAmount ?? 0).toLocaleString(), u: unit(s.currency), v: Math.abs(v2) });
      case 'STALE_REQUESTS':
        return t('sig.STALE_REQUESTS.what', { n: s.count ?? 0, h: s.hours, total: s.base ?? 0 });
      case 'UNFINISHED_NO_NEXT':
        if (!s.count) return t('sig.UNFINISHED_NO_NEXT.none', { d: s.windowDays, total: s.base ?? 0 });
        return t('sig.UNFINISHED_NO_NEXT.what', { n: s.count ?? 0, d: s.windowDays, total: s.base ?? 0 });
      case 'NO_REBOOK':
        return t('sig.NO_REBOOK.what', { n: s.count ?? 0, total: s.base ?? 0 });
      case 'OVERDUE_TASKS':
        if (!s.count) return t('sig.OVERDUE_TASKS.none', { total: s.base ?? 0 });
        return t('sig.OVERDUE_TASKS.what', { n: s.count ?? 0, total: s.base ?? 0 });
      default:
        return t('sig.SYNC_OVERDUE.what', { date: s.lastSyncAt ? fmtDateTime(s.lastSyncAt) : '—', h: v2 });
    }
  };
  // the dates and secondary numbers of a measured signal (shown under the details)
  const details = (): string[] => {
    if (s.state !== 'fired' && s.state !== 'ok') return [];
    if (s.kind === 'RETURN_DROP' || s.kind === 'PAYMENTS_DROP') return [t('sig.detail.compare', { period: period(s.from, s.to), prevPeriod: period(s.prevFrom, s.prevTo) })];
    if (s.kind === 'CANCEL_RATE') return [t('sig.detail.period', { period: period(s.from, s.to) })];
    if (s.kind === 'NO_REBOOK') return [t('sig.detail.missed', { period: period(s.from, s.to) })];
    if (s.kind === 'UNFINISHED_NO_NEXT' && s.count) return [t('sig.detail.oldestPatient', { n: s.oldestDays ?? 0 })];
    if (s.kind === 'OVERDUE_TASKS' && s.count) return [t('sig.detail.oldestTask', { n: s.oldestDays ?? 0 })];
    return [];
  };
  return { what, details };
}
