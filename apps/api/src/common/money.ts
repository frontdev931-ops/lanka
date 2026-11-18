import type { Lang } from './i18n';

// Money from Cliniccards and its currency (decided 2026-11-16).
//
// What each amount is:
//   - payments (Payment.amount), invoices (Invoice.amount), the card balances (Patient.balanceIssued / balancePaid) and plan totals
//     (TreatmentPlan.total / totalDone): amounts of the clinic's accounts in Cliniccards. The API sends them WITHOUT a currency. Plan totals are
//     documented (and were checked on a live clinic) as the clinic's main currency with the plan's fixed rate; for the others nothing is sent.
//     So the currency is what the clinic's owner states, in two separate scopes (Clinic.sourceCurrency for payments, invoices and balances;
//     Clinic.planCurrency for plan totals, because a clinic may keep some plans in another currency), stamped on each row when it is loaded.
//     A statement is valid only when ALL amounts of its group are in that currency; otherwise the owner leaves it unconfirmed.
//     A row without a stamp is "currency not confirmed".
//   - prices of plan items (PlanItem.price) and the amount of a visit (Visit.amount, the sum of its item prices): Cliniccards lets a price be in
//     another currency and does not say which. They are "unconverted": never labelled with a currency, never added to the amounts above.
//
// Rules: amounts of different currencies are never added into one number (totals are a list, one per currency); "unknown" is a currency of its own
// in that list; there is no conversion (no rate is applied anywhere).

export const SOURCE_CURRENCIES = ['UAH', 'USD', 'EUR', 'PLN', 'GBP', 'CZK'] as const;
export type SourceCurrency = (typeof SOURCE_CURRENCIES)[number];
// null: not confirmed
export type Cur = string | null;
export interface MoneyTotal {
  currency: Cur;
  amount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Totals per currency (unknown last). Amounts with different currencies stay apart.
export function sumByCurrency(items: Iterable<{ currency: Cur; amount: number | string | { toString(): string } | null | undefined }>): MoneyTotal[] {
  const by = new Map<Cur, number>();
  for (const i of items) {
    const n = Number(i.amount ?? 0);
    if (!Number.isFinite(n)) continue;
    by.set(i.currency ?? null, (by.get(i.currency ?? null) ?? 0) + n);
  }
  return [...by]
    .map(([currency, amount]) => ({ currency, amount: round2(amount) }))
    .sort((a, b) => (a.currency === null ? 1 : b.currency === null ? -1 : a.currency.localeCompare(b.currency)));
}

// One currency for a set of stamps: the code when every stamp is the same known code, 'unknown' when every stamp is missing, 'mixed' otherwise
export function oneCurrency(stamps: Iterable<Cur>): { kind: 'one'; code: string } | { kind: 'unknown' } | { kind: 'mixed' } | { kind: 'none' } {
  const set = new Set<Cur>();
  for (const s of stamps) set.add(s ?? null);
  if (!set.size) return { kind: 'none' };
  if (set.size > 1) return { kind: 'mixed' };
  const [only] = [...set];
  return only === null ? { kind: 'unknown' } : { kind: 'one', code: only };
}

// The unit as people read it: "грн" for hryvnias in Ukrainian and Russian, the code otherwise
export function unitOf(code: string, lang: Lang): string {
  if (code === 'UAH') return lang === 'en' ? 'UAH' : 'грн';
  return code;
}

export const CURRENCY_TEXT: Record<Lang, { unknown: string; unknownShort: string; unconverted: string; column: string; note: string; unconvertedNote: string; mixedNote: string }> = {
  uk: {
    unknown: 'валюта не підтверджена',
    unknownShort: 'валюта?',
    unconverted: 'ціни послуг, без конвертації',
    column: 'Валюта',
    note: 'Валюту сум не підтверджено: власник клініки вказує її в налаштуваннях Cliniccards. Суми показано без позначки валюти.',
    unconvertedNote: 'Суми візитів складені з цін послуг Cliniccards, які можуть бути в різних валютах; їх не конвертовано й не позначено валютою.',
    mixedNote: 'Суми в різних валютах не додаються: кожна валюта показана окремо.',
  },
  ru: {
    unknown: 'валюта не подтверждена',
    unknownShort: 'валюта?',
    unconverted: 'цены услуг, без конвертации',
    column: 'Валюта',
    note: 'Валюта сумм не подтверждена: владелец клиники указывает её в настройках Cliniccards. Суммы показаны без обозначения валюты.',
    unconvertedNote: 'Суммы визитов сложены из цен услуг Cliniccards, которые могут быть в разных валютах; они не конвертированы и не обозначены валютой.',
    mixedNote: 'Суммы в разных валютах не складываются: каждая валюта показана отдельно.',
  },
  en: {
    unknown: 'currency not confirmed',
    unknownShort: 'currency?',
    unconverted: 'service prices, not converted',
    column: 'Currency',
    note: 'The currency of the amounts is not confirmed: the clinic owner states it in the Cliniccards settings. Amounts are shown without a currency.',
    unconvertedNote: 'Visit amounts are sums of Cliniccards service prices, which may be in different currencies; they are not converted and carry no currency.',
    mixedNote: 'Amounts in different currencies are not added up: each currency is shown separately.',
  },
};

// "12 300 грн", "450 USD", "1 200 (валюта не підтверджена)"
export function formatMoney(t: MoneyTotal, lang: Lang): string {
  const n = new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'uk-UA', { maximumFractionDigits: 0 }).format(t.amount).replace(/ /g, ' ');
  return t.currency ? `${n} ${unitOf(t.currency, lang)}` : `${n} (${CURRENCY_TEXT[lang].unknown})`;
}

export const formatTotals = (list: MoneyTotal[], lang: Lang): string => (list.length ? list.map((t) => formatMoney(t, lang)).join('; ') : formatMoney({ currency: null, amount: 0 }, lang).replace(/ \(.*\)$/, ''));
