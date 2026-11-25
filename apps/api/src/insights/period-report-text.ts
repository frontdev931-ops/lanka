// Weekly and monthly reports to managers (2026-11-25): the periods in the clinic's time and the text, fixed templates in three languages, no AI.
// The text keeps two things apart: the figures OF the period (with the previous comparable period) and what needs attention NOW (the state when
// the report was prepared, never presented as new cases of the period). Aggregate numbers only: no names, phones, diagnoses or records.
import { CLINIC_TZ, clinicDate, localToUtc } from '../common/clinic-time';
import { MoneyTotal, unitOf } from '../common/money';
import { headline, signalAction, SignalFacts, SignalLang, SignalSettings } from './signal-text';

export type PeriodKind = 'WEEKLY' | 'MONTHLY';
export const PERIOD_KINDS: PeriodKind[] = ['WEEKLY', 'MONTHLY'];

// A period of whole clinic days: from and to are both included (YYYY-MM-DD); since / end are the clinic's midnights (end = after `to`)
export interface PeriodRange {
  kind: PeriodKind;
  from: string;
  to: string;
  since: Date;
  end: Date;
  days: number;
}

const DAY = 86_400_000;
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
// 1 = Monday … 7 = Sunday
const weekdayOf = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay() || 7;
const firstOfMonth = (ymd: string) => `${ymd.slice(0, 7)}-01`;
const prevMonthFirst = (first: string) => {
  const [y, m] = first.split('-').map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
};
const nextMonthFirst = (first: string) => {
  const [y, m] = first.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (s: string) => ISO.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// The period that starts on `from` (a Monday for a week, the 1st for a month); null if `from` is not such a day
export function periodOf(kind: PeriodKind, from: string): PeriodRange | null {
  if (!validDay(from)) return null;
  if (kind === 'WEEKLY' && weekdayOf(from) !== 1) return null;
  if (kind === 'MONTHLY' && from.slice(8) !== '01') return null;
  const after = kind === 'WEEKLY' ? addDays(from, 7) : nextMonthFirst(from);
  const since = localToUtc(`${from} 00:00:00`, CLINIC_TZ);
  const end = localToUtc(`${after} 00:00:00`, CLINIC_TZ);
  // days by the calendar, not by hours (a week with a clock change is still 7 days)
  const days = Math.round((Date.parse(`${after}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
  return { kind, from, to: addDays(after, -1), since, end, days };
}

// The last COMPLETED period at the moment `now`: the Monday–Sunday week before the current one, or the previous calendar month
export function lastCompleted(kind: PeriodKind, now: Date): PeriodRange {
  const today = clinicDate(now, CLINIC_TZ);
  const from = kind === 'WEEKLY' ? addDays(today, -(weekdayOf(today) - 1) - 7) : prevMonthFirst(firstOfMonth(today));
  return periodOf(kind, from)!;
}

export function previousPeriod(p: PeriodRange): PeriodRange {
  return periodOf(p.kind, p.kind === 'WEEKLY' ? addDays(p.from, -7) : prevMonthFirst(p.from))!;
}

// The completed periods one may open in the workspace, newest first
export function recentPeriods(kind: PeriodKind, now: Date, n: number): PeriodRange[] {
  const out = [lastCompleted(kind, now)];
  while (out.length < n) out.push(previousPeriod(out[out.length - 1]));
  return out;
}

// When the report of period p is due: the week's report on the chosen weekday of the week after it, the month's on the 1st of the next month,
// at the chosen hour in the clinic's time (the clock change is handled by localToUtc)
export function dueAt(p: PeriodRange, cfg: { weekday: number; hour: number }): Date {
  const day = p.kind === 'WEEKLY' ? addDays(addDays(p.to, 1), cfg.weekday - 1) : addDays(p.to, 1);
  return localToUtc(`${day} ${String(cfg.hour).padStart(2, '0')}:00:00`, CLINIC_TZ);
}

// ---------- the facts and the text ----------

export interface PeriodTotals {
  completed: number;
  cancelled: number;
  noShow: number;
  scheduled: number;
  unclosed: number;
  newPatients: number;
  paid: MoneyTotal[];
  paymentsCount: number;
}
// What needs attention now: a signal that is at its threshold (its measured facts) or a plain fact of LANKA's own data
export interface CurrentIssue {
  kind: string;
  facts?: SignalFacts;
  settings?: SignalSettings;
  count?: number;
}
// What the "needs attention now" part really checked. signals: 'checked' (the switched-on rules were measured), 'not_in_plan', 'all_off' (every
// rule switched off in the settings; not an error); notMeasured: switched-on rules without a value (too little data, an old Cliniccards load);
// failed: rules whose check threw; factsFailed: LANKA's own checks (requests, tasks, visits without a result) that failed (of 3)
export interface IssueChecks {
  signals: 'checked' | 'not_in_plan' | 'all_off';
  notMeasured: number;
  failed: number;
  factsFailed: number;
}
export const FACT_CHECKS = 3;
export interface ReportFacts {
  state: 'READY' | 'STALE';
  preparedAt: string;
  connected: boolean;
  lastSyncAt: string | null;
  cur?: PeriodTotals;
  prev?: PeriodTotals;
  issues: CurrentIssue[];
  checks?: IssueChecks;
}

const locale = (lang: SignalLang) => (lang === 'en' ? 'en-GB' : 'uk-UA');
const num = (n: number, lang: SignalLang, digits = 0) => new Intl.NumberFormat(locale(lang), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n).replace(/\s/g, ' ');
const day = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;
const dayTime = (iso: string, lang: SignalLang) => new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : lang === 'ru' ? 'ru-RU' : 'uk-UA', { timeZone: CLINIC_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const money = (amount: number, currency: string | null, lang: SignalLang) => `${num(amount, lang)} ${currency ? unitOf(currency, lang) : ''}`.trim();
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

const L = {
  uk: {
    week: 'Звіт за тиждень', month: 'Звіт за місяць', days: '{n} дн.', inPeriod: 'За період', completed: 'Завершені візити: {v}', newPatients: 'Нові пацієнти (нові картки в Cliniccards): {v}',
    missed: 'Скасування й неявки: {n} з {total} візитів із відомим результатом — {share}', missedSplit: 'скасовано {c}, не прийшли {s}', noScheduled: 'Скасування й неявки: візитів із відомим результатом не було — частку не рахуємо', paid: 'Отримані оплати: {v}', noPaid: 'Отримані оплати: оплат не було', unclosed: 'Візитів без відмітки, чи прийшов пацієнт: {v} (у частку не входять)',
    prev: 'попер.: {v}', pp: 'п. п.', compareWeek: 'Порівняння з попереднім тижнем {a} — {b}.', compareMonth: 'Порівняння з попереднім місяцем {a} — {b} ({pd} дн.; цей місяць — {cd} дн.).',
    now: 'Зараз потребує уваги (стан на {at}; це не нові випадки за період):', calm: 'За доступними даними немає пунктів, що потребують уваги (стан на {at}).', more: 'Детальніше в LANKA',
    notInPlan: 'Сигнали керівнику недоступні за тарифом: перевірено лише заявки, завдання й візити без відмітки результату.', allOff: 'Усі сигнали вимкнено в налаштуваннях: перевірено лише заявки, завдання й візити без відмітки результату.', notMeasured: 'Не пораховано сигналів: {n} (мало даних або застарілі дані Cliniccards), тож список може бути неповним.', failed: 'Не вдалося виконати перевірок: {n}, тож список може бути неповним.', unknown: 'Перевірки не виконано (стан на {at}), тому що зараз потребує уваги, невідомо.',
    stale: 'Звіт не сформовано: дані з Cliniccards востаннє оновлено {at}, тобто не за весь період. Неповні цифри не надсилаємо. Перевірте синхронізацію в Налаштуваннях; після оновлення звіт можна переглянути в LANKA.', notConnected: 'Звіт не сформовано: Cliniccards не підключено, тож даних про візити й оплати немає.',
    OPEN_REQUESTS: 'Заявок без відповіді понад 4 год.: {n}', OVERDUE: 'Прострочених завдань команди: {n}', UNCLOSED_NOW: 'Минулих візитів без підсумку в Cliniccards: {n}',
    OPEN_REQUESTS_act: 'відкрити заявки й обробити найстаріші.', OVERDUE_act: 'відкрити завдання й виконати, перепризначити або закрити неактуальні.', UNCLOSED_NOW_act: 'попросити адміністратора закрити ці візити в Cliniccards (прийшов, не прийшов, скасовано).',
  },
  ru: {
    week: 'Отчёт за неделю', month: 'Отчёт за месяц', days: '{n} дн.', inPeriod: 'За период', completed: 'Завершённые визиты: {v}', newPatients: 'Новые пациенты (новые карточки в Cliniccards): {v}',
    missed: 'Отмены и неявки: {n} из {total} визитов с известным результатом — {share}', missedSplit: 'отменено {c}, не пришли {s}', noScheduled: 'Отмены и неявки: визитов с известным результатом не было — долю не считаем', paid: 'Полученные оплаты: {v}', noPaid: 'Полученные оплаты: оплат не было', unclosed: 'Визитов без отметки, пришёл ли пациент: {v} (в долю не входят)',
    prev: 'пред.: {v}', pp: 'п. п.', compareWeek: 'Сравнение с предыдущей неделей {a} — {b}.', compareMonth: 'Сравнение с предыдущим месяцем {a} — {b} ({pd} дн.; этот месяц — {cd} дн.).',
    now: 'Сейчас требует внимания (состояние на {at}; это не новые случаи за период):', calm: 'По доступным данным нет пунктов, требующих внимания (состояние на {at}).', more: 'Подробнее в LANKA',
    notInPlan: 'Сигналы руководителю недоступны по тарифу: проверены только заявки, задачи и визиты без отметки результата.', allOff: 'Все сигналы выключены в настройках: проверены только заявки, задачи и визиты без отметки результата.', notMeasured: 'Не посчитано сигналов: {n} (мало данных или устаревшие данные Cliniccards), поэтому список может быть неполным.', failed: 'Не удалось выполнить проверок: {n}, поэтому список может быть неполным.', unknown: 'Проверки не выполнены (состояние на {at}), поэтому что сейчас требует внимания, неизвестно.',
    stale: 'Отчёт не сформирован: данные из Cliniccards последний раз обновлены {at}, то есть не за весь период. Неполные цифры не отправляем. Проверьте синхронизацию в Настройках; после обновления отчёт можно посмотреть в LANKA.', notConnected: 'Отчёт не сформирован: Cliniccards не подключён, поэтому данных о визитах и оплатах нет.',
    OPEN_REQUESTS: 'Заявок без ответа больше 4 ч.: {n}', OVERDUE: 'Просроченных задач команды: {n}', UNCLOSED_NOW: 'Прошлых визитов без итога в Cliniccards: {n}',
    OPEN_REQUESTS_act: 'открыть заявки и обработать самые старые.', OVERDUE_act: 'открыть задачи и выполнить, переназначить или закрыть неактуальные.', UNCLOSED_NOW_act: 'попросить администратора закрыть эти визиты в Cliniccards (пришёл, не пришёл, отменён).',
  },
  en: {
    week: 'Weekly report', month: 'Monthly report', days: '{n} days', inPeriod: 'In the period', completed: 'Completed visits: {v}', newPatients: 'New patients (new cards in Cliniccards): {v}',
    missed: 'Cancellations and no-shows: {n} of {total} visits with a known result — {share}', missedSplit: 'cancelled {c}, did not come {s}', noScheduled: 'Cancellations and no-shows: no visits with a known result, so no share', paid: 'Payments received: {v}', noPaid: 'Payments received: none', unclosed: 'Visits with no mark whether the patient came: {v} (not in the share)',
    prev: 'prev.: {v}', pp: 'pp', compareWeek: 'Compared with the previous week {a} — {b}.', compareMonth: 'Compared with the previous month {a} — {b} ({pd} days; this month {cd} days).',
    now: 'Needs attention now (as of {at}; these are not new cases of the period):', calm: 'By the available data, nothing needs attention (as of {at}).', more: 'More in LANKA',
    notInPlan: 'Manager signals are not in the plan: only requests, tasks and visits without a result mark were checked.', allOff: 'All signals are switched off in the settings: only requests, tasks and visits without a result mark were checked.', notMeasured: 'Signals not calculated: {n} (too little data or old Cliniccards data), so the list may be incomplete.', failed: 'Checks that could not run: {n}, so the list may be incomplete.', unknown: 'The checks did not run (as of {at}), so what needs attention now is unknown.',
    stale: 'The report was not prepared: the Cliniccards data was last updated {at}, so it does not cover the whole period. Incomplete figures are not sent. Check the sync in the Settings; after an update the report can be viewed in LANKA.', notConnected: 'The report was not prepared: Cliniccards is not connected, so there is no data on visits and payments.',
    OPEN_REQUESTS: 'Requests without a reply for over 4 h: {n}', OVERDUE: 'Overdue team tasks: {n}', UNCLOSED_NOW: 'Past visits without an outcome in Cliniccards: {n}',
    OPEN_REQUESTS_act: 'open the requests and handle the oldest ones.', OVERDUE_act: 'open the tasks and complete, reassign or close the ones no longer needed.', UNCLOSED_NOW_act: 'ask the administrator to close these visits in Cliniccards (came, did not come, cancelled).',
  },
};

const sign = (n: number, lang: SignalLang, digits = 0) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${num(Math.abs(n), lang, digits)}`;
// A count with the previous period: the difference, and a percentage only when the previous value is not zero (never "infinity")
function countCmp(cur: number, prev: number | undefined, lang: SignalLang) {
  if (prev === undefined) return num(cur, lang);
  const t = L[lang];
  const parts = [fill(t.prev, { v: num(prev, lang) })];
  if (cur !== prev) parts.push(sign(cur - prev, lang) + (prev > 0 ? `, ${sign(((cur - prev) / prev) * 100, lang, 1)}%` : ''));
  return `${num(cur, lang)} (${parts.join('; ')})`;
}
// The share of cancellations and no-shows, its change in percentage points
const share = (t: PeriodTotals) => (t.scheduled > 0 ? ((t.cancelled + t.noShow) / t.scheduled) * 100 : null);

// The current issues (at most three, a fixed order) as lines with one action each
export function issueLines(issues: CurrentIssue[], lang: SignalLang): string[] {
  const t = L[lang] as Record<string, string>;
  return issues.slice(0, 3).map((i, n) => {
    const text = i.facts && i.settings ? `${headline(i.kind, i.facts, i.settings, lang)} — ${signalAction(i.kind, lang)}` : `${fill(t[i.kind] ?? i.kind, { n: i.count ?? 0 })} — ${t[`${i.kind}_act`] ?? ''}`;
    return `${n + 1}. ${text}`;
  });
}

// The "needs attention now" part: the items, or the neutral line only when the available checks ran; then what limited them. Signals switched off
// in the settings are a choice, not an error: they are named only when ALL are off, as the scope of what was checked.
export function attentionLines(f: Pick<ReportFacts, 'issues' | 'checks' | 'preparedAt'>, lang: SignalLang): string[] {
  const t = L[lang];
  const at = dayTime(f.preparedAt, lang);
  const c = f.checks ?? { signals: 'checked', notMeasured: 0, failed: 0, factsFailed: 0 };
  const nothingRan = c.factsFailed >= FACT_CHECKS && (c.signals !== 'checked' || c.failed > 0);
  const out: string[] = [];
  if (f.issues.length) out.push(fill(t.now, { at }), ...issueLines(f.issues, lang));
  else if (nothingRan) return [fill(t.unknown, { at })];
  else out.push(fill(t.calm, { at }));
  if (c.signals === 'not_in_plan') out.push(t.notInPlan);
  if (c.signals === 'all_off') out.push(t.allOff);
  if (c.notMeasured > 0) out.push(fill(t.notMeasured, { n: c.notMeasured }));
  if (c.failed + c.factsFailed > 0) out.push(fill(t.failed, { n: c.failed + c.factsFailed }));
  return out;
}

export function reportText(a: { clinic: string; period: PeriodRange; prevPeriod: PeriodRange; facts: ReportFacts; url: string }, lang: SignalLang): string {
  const t = L[lang];
  const { period: p, prevPeriod: pp, facts: f } = a;
  const head = [`${a.clinic} · ${p.kind === 'WEEKLY' ? t.week : t.month}`, `${day(p.from)} — ${day(p.to)}${p.kind === 'MONTHLY' ? ` (${fill(t.days, { n: p.days })})` : ''}`, ''];
  if (f.state === 'STALE' || !f.cur) {
    return [...head, f.connected && f.lastSyncAt ? fill(t.stale, { at: dayTime(f.lastSyncAt, lang) }) : f.connected ? fill(t.stale, { at: '—' }) : t.notConnected, '', `${t.more} → ${a.url}`].join('\n');
  }
  const c = f.cur;
  const v = f.prev;
  const lines = [...head, t.inPeriod];
  lines.push(`• ${fill(t.completed, { v: countCmp(c.completed, v?.completed, lang) })}`);
  lines.push(`• ${fill(t.newPatients, { v: countCmp(c.newPatients, v?.newPatients, lang) })}`);
  const s = share(c);
  if (s === null) lines.push(`• ${t.noScheduled}`);
  else {
    const ps = v ? share(v) : null;
    const shareText = `${num(s, lang, 1)}%` + (ps !== null ? ` (${fill(t.prev, { v: `${num(ps, lang, 1)}%` })}; ${sign(s - ps, lang, 1)} ${t.pp})` : '');
    lines.push(`• ${fill(t.missed, { n: c.cancelled + c.noShow, total: c.scheduled, share: shareText })}; ${fill(t.missedSplit, { c: c.cancelled, s: c.noShow })}`);
  }
  // each currency on its own, compared only with the same currency
  const currencies = [...new Set([...c.paid, ...(v?.paid ?? [])].map((x) => x.currency))];
  if (!currencies.length) lines.push(`• ${t.noPaid}`);
  else
    for (const cur of currencies) {
      const now = c.paid.find((x) => x.currency === cur)?.amount ?? 0;
      const before = v ? v.paid.find((x) => x.currency === cur)?.amount ?? 0 : undefined;
      const tail = before === undefined ? '' : ` (${fill(t.prev, { v: money(before, cur, lang) })}${before > 0 && now !== before ? `; ${sign(((now - before) / before) * 100, lang, 1)}%` : ''})`;
      lines.push(`• ${fill(t.paid, { v: money(now, cur, lang) + tail })}`);
    }
  if (c.unclosed > 0) lines.push(`• ${fill(t.unclosed, { v: c.unclosed })}`);
  lines.push('', p.kind === 'WEEKLY' ? fill(t.compareWeek, { a: day(pp.from), b: day(pp.to) }) : fill(t.compareMonth, { a: day(pp.from), b: day(pp.to), pd: pp.days, cd: p.days }), '');
  lines.push(...attentionLines(f, lang));
  lines.push('', `${t.more} → ${a.url}`);
  return lines.join('\n');
}
