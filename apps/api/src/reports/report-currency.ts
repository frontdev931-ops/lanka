import type { Lang } from '../common/i18n';
import { CURRENCY_TEXT, Cur, oneCurrency, unitOf } from '../common/money';

// Money columns of a report (ready reports and the report builder) and how their currency is shown. See common/money.ts for what each amount is.
//   source:      an amount of the clinic's accounts in Cliniccards (payments, invoices, balances, plan totals). Each row carries the stamp of its amounts in
//                `currency` (a code, null = not confirmed, MIXED = this row's amounts have different stamps and its money cells are text per currency).
//   unconverted: sums of service prices (visit amounts, plan item prices): never labelled with a currency.
export type MoneyKind = 'source' | 'unconverted';
export const MIXED = 'MIXED';
export type RowCur = Cur | typeof MIXED;

export interface CurrencyInfo {
  // the one currency of every source amount of the report; null when not confirmed or when rows differ (then the `currency` column is there)
  code: string | null;
  state: 'one' | 'unknown' | 'mixed' | 'none';
}

interface Shaped {
  columns: { key: string; label: string; money?: MoneyKind }[];
  rows: Record<string, unknown>[];
  rule: string;
  currency?: CurrencyInfo;
}

// The label of the "currency" cell
export function currencyCell(lang: Lang, v: unknown): string {
  if (v === MIXED) return lang === 'en' ? 'several' : lang === 'ru' ? 'несколько' : 'кілька';
  return typeof v === 'string' && v ? v : CURRENCY_TEXT[lang].unknownShort;
}

// Puts the currency into the column labels themselves (so the screen, Excel, PDF, CSV and the AI read the same words) and into the rule:
//   - every source amount has the same known code: "Борг, грн";
//   - none is confirmed: "Борг (валюта не підтверджена)" and a note in the rule;
//   - rows differ: a "Валюта" column next to the amounts, no unit in the labels, a note that currencies are not added up;
//   - unconverted sums: "Виручка (ціни послуг, без конвертації)" and a note.
// The rows' `currency` cell stays in the data; it is shown only as that extra column.
export function finishCurrency<R extends Shaped>(report: R, lang: Lang): R {
  const t = CURRENCY_TEXT[lang];
  const source = report.columns.filter((c) => c.money === 'source');
  const unconverted = report.columns.filter((c) => c.money === 'unconverted');
  const notes: string[] = [];
  let info: CurrencyInfo = { code: null, state: 'none' };
  let columns = report.columns;
  if (source.length) {
    const stamps = report.rows.map((r) => (r.currency === MIXED ? MIXED : ((r.currency as Cur) ?? null)));
    const one = stamps.includes(MIXED) ? { kind: 'mixed' as const } : oneCurrency(stamps as Cur[]);
    if (one.kind === 'one') {
      info = { code: one.code, state: 'one' };
      columns = columns.map((c) => (c.money === 'source' ? { ...c, label: `${c.label}, ${unitOf(one.code, lang)}` } : c));
    } else if (one.kind === 'unknown') {
      info = { code: null, state: 'unknown' };
      columns = columns.map((c) => (c.money === 'source' ? { ...c, label: `${c.label} (${t.unknown})` } : c));
      notes.push(t.note);
    } else if (one.kind === 'mixed') {
      info = { code: null, state: 'mixed' };
      const last = Math.max(...source.map((c) => columns.indexOf(c)));
      columns = [...columns.slice(0, last + 1), { key: 'currency', label: t.column }, ...columns.slice(last + 1)];
      notes.push(t.mixedNote);
      if (stamps.some((s) => s === null)) notes.push(t.note);
    }
  }
  if (unconverted.length) {
    columns = columns.map((c) => (c.money === 'unconverted' ? { ...c, label: `${c.label} (${t.unconverted})` } : c));
    notes.push(t.unconvertedNote);
  }
  // the rules end without a period (the pages add their own after them), so the notes keep that form
  const rule = notes.length ? `${report.rule.replace(/\.?\s*$/, '.')} ${notes.join(' ').replace(/\.\s*$/, '')}` : report.rule;
  return { ...report, columns, rule, currency: info };
}
