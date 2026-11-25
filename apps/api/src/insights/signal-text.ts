// Texts of the manager signals (2026-11-25): fixed templates in three languages, no AI. Every message says which clinic, what happened, the exact
// condition with its numbers and period, the change against the previous comparable measurement when it is known, ONE concrete action and the
// link to the matching data in LANKA. Aggregate numbers only: no names, phones or amounts of money (a legacy staff group may include anyone).
// The threshold is a setting and is not repeated in the text; nothing here claims a cause, a loss or a lost patient.
import { CLINIC_TZ } from '../common/clinic-time';

export type SignalLang = 'uk' | 'ru' | 'en';
export const signalLang = (l?: string | null): SignalLang => (l === 'ru' || l === 'en' ? l : 'uk');

// The measured facts as stored on an event (dates may come back from JSON as strings)
export interface SignalFacts {
  value: number;
  from?: Date | string;
  to?: Date | string;
  prevFrom?: Date | string;
  prevTo?: Date | string;
  count?: number;
  base?: number;
  oldestDays?: number;
  lookbackDays?: number;
  lastSyncAt?: Date | string;
}
export interface SignalSettings {
  windowDays: number;
  hours: number;
}

const date = (d: Date | string | undefined, lang: SignalLang) =>
  d ? new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : lang === 'ru' ? 'ru-RU' : 'uk-UA', { timeZone: CLINIC_TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d)) : '—';
const dateTime = (d: Date | string | undefined, lang: SignalLang) =>
  d ? new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : lang === 'ru' ? 'ru-RU' : 'uk-UA', { timeZone: CLINIC_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(d)) : '—';
// a period's end is exclusive (the start of the next day): the text shows the last day it covers
const period = (a: Date | string | undefined, b: Date | string | undefined, lang: SignalLang) => (a && b ? `${date(a, lang)} — ${date(new Date(new Date(b).getTime() - 1), lang)}` : '—');

// Ukrainian and Russian plural forms: one / few / many
function plural(lang: SignalLang, n: number, forms: [string, string, string]) {
  if (lang === 'en') return n === 1 ? forms[0] : forms[2];
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
  return forms[2];
}
const W: Record<SignalLang, Record<string, [string, string, string]>> = {
  uk: { patient: ['пацієнт', 'пацієнти', 'пацієнтів'], request: ['заявка', 'заявки', 'заявок'], task: ['завдання', 'завдання', 'завдань'], visit: ['візит', 'візити', 'візитів'] },
  ru: { patient: ['пациент', 'пациента', 'пациентов'], request: ['заявка', 'заявки', 'заявок'], task: ['задача', 'задачи', 'задач'], visit: ['визит', 'визита', 'визитов'] },
  en: { patient: ['patient', 'patients', 'patients'], request: ['request', 'requests', 'requests'], task: ['task', 'tasks', 'tasks'], visit: ['visit', 'visits', 'visits'] },
};
const n = (lang: SignalLang, v: number, w: string) => `${v} ${plural(lang, v, W[lang][w])}`;

const L = {
  uk: { attention: 'Потрібна увага', todo: 'Що зробити', prev: 'Попередня перевірка ({at}): {v}.', patients: 'Переглянути пацієнтів', details: 'Відкрити подробиці', current: 'Поточний стан сигналів', fired: 'Потребують уваги', ok: 'У нормі', pending: 'Не розраховано (мало даних або потрібне оновлення з Cliniccards)', off: 'Вимкнено', none: 'Відхилень зараз немає.', open: 'Відкрити сигнали' },
  ru: { attention: 'Нужно внимание', todo: 'Что сделать', prev: 'Предыдущая проверка ({at}): {v}.', patients: 'Посмотреть пациентов', details: 'Открыть подробности', current: 'Текущее состояние сигналов', fired: 'Требуют внимания', ok: 'В норме', pending: 'Не рассчитано (мало данных или нужно обновление из Cliniccards)', off: 'Выключено', none: 'Отклонений сейчас нет.', open: 'Открыть сигналы' },
  en: { attention: 'Needs attention', todo: 'What to do', prev: 'Previous check ({at}): {v}.', patients: 'View patients', details: 'Open the details', current: 'Current state of signals', fired: 'Need attention', ok: 'Normal', pending: 'Not calculated (too little data or a Cliniccards update is needed)', off: 'Switched off', none: 'No deviations right now.', open: 'Open signals' },
};
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

// Rules whose link opens the list of patients that the rule counted
export const PATIENT_KINDS = ['NO_REBOOK', 'UNFINISHED_NO_NEXT'];
const PCT_KINDS = ['CANCEL_RATE', 'RETURN_DROP', 'PAYMENTS_DROP'];
const valueIn = (kind: string, v: number, lang: SignalLang) => (kind === 'SYNC_OVERDUE' ? `${v} ${lang === 'en' ? 'h' : lang === 'ru' ? 'ч' : 'год'}` : PCT_KINDS.includes(kind) ? `${v}%` : String(v));

// The headline: what happened, with the number (also the line of the current-state summary)
export function headline(kind: string, f: SignalFacts, s: SignalSettings, lang: SignalLang): string {
  const v = f.value;
  const c = f.count ?? v;
  switch (kind) {
    case 'CANCEL_RATE':
      return { uk: `Скасування й неявки: ${v}% візитів`, ru: `Отмены и неявки: ${v}% визитов`, en: `Cancellations and no-shows: ${v}% of visits` }[lang];
    case 'RETURN_DROP':
      return { uk: `Завершених візитів менше на ${v}%`, ru: `Завершённых визитов меньше на ${v}%`, en: `${v}% fewer completed visits` }[lang];
    case 'PAYMENTS_DROP':
      return { uk: `Отримані оплати менші на ${v}%`, ru: `Полученные оплаты меньше на ${v}%`, en: `Payments received are ${v}% lower` }[lang];
    case 'STALE_REQUESTS':
      return { uk: `${n(lang, c, 'request')} чекають понад ${s.hours} год.`, ru: `${n(lang, c, 'request')} ждут больше ${s.hours} ч.`, en: `${n(lang, c, 'request')} waiting over ${s.hours} h` }[lang];
    case 'UNFINISHED_NO_NEXT':
      return { uk: `${n(lang, c, 'patient')}: незавершене лікування без наступного запису`, ru: `${n(lang, c, 'patient')}: незавершённое лечение без следующей записи`, en: `${n(lang, c, 'patient')}: unfinished treatment without a next visit` }[lang];
    case 'NO_REBOOK':
      return { uk: `${n(lang, c, 'patient')} без повторного запису після скасування чи неявки`, ru: `${n(lang, c, 'patient')} без повторной записи после отмены или неявки`, en: `${n(lang, c, 'patient')} not rebooked after a cancellation or no-show` }[lang];
    case 'OVERDUE_TASKS':
      return { uk: `${n(lang, c, 'task')} команди прострочено`, ru: `Просрочено ${n(lang, c, 'task')} команды`, en: `${n(lang, c, 'task')} of the team overdue` }[lang];
    default:
      return { uk: `Дані з Cliniccards не оновлювалися ${v} год.`, ru: `Данные из Cliniccards не обновлялись ${v} ч.`, en: `Cliniccards data not updated for ${v} h` }[lang];
  }
}

// The exact condition under which something is counted, with the period and the numbers it was calculated from
function condition(kind: string, f: SignalFacts, s: SignalSettings, lang: SignalLang): string {
  const p = period(f.from, f.to, lang);
  const pp = period(f.prevFrom, f.prevTo, lang);
  switch (kind) {
    case 'CANCEL_RATE':
      return {
        uk: `За ${p} (${s.windowDays} повних дн.) скасовано або пропущено ${f.count ?? 0} з ${n(lang, f.base ?? 0, 'visit')}.`,
        ru: `За ${p} (${s.windowDays} полных дн.) отменено или пропущено ${f.count ?? 0} из ${n(lang, f.base ?? 0, 'visit')}.`,
        en: `In ${p} (${s.windowDays} complete days) ${f.count ?? 0} of ${n(lang, f.base ?? 0, 'visit')} were cancelled or missed.`,
      }[lang];
    case 'RETURN_DROP':
      return {
        uk: `Завершених візитів: ${f.count ?? 0} за ${p} проти ${f.base ?? 0} за ${pp}.`,
        ru: `Завершённых визитов: ${f.count ?? 0} за ${p} против ${f.base ?? 0} за ${pp}.`,
        en: `Completed visits: ${f.count ?? 0} in ${p} against ${f.base ?? 0} in ${pp}.`,
      }[lang];
    case 'PAYMENTS_DROP':
      return {
        uk: `Сума оплат за ${p} порівняно з ${pp}, за даними Cliniccards.`,
        ru: `Сумма оплат за ${p} по сравнению с ${pp}, по данным Cliniccards.`,
        en: `The sum of payments in ${p} compared with ${pp}, by the Cliniccards data.`,
      }[lang];
    case 'STALE_REQUESTS':
      return {
        uk: `Нові заявки на запис, перенесення, скасування або на зв’язок з адміністратором, створені понад ${s.hours} год. тому й досі не оброблені. Усього нових заявок: ${f.base ?? 0}.`,
        ru: `Новые заявки на запись, перенос, отмену или на связь с администратором, созданные больше ${s.hours} ч. назад и до сих пор не обработанные. Всего новых заявок: ${f.base ?? 0}.`,
        en: `New requests to book, reschedule, cancel or talk to the administrator, created over ${s.hours} h ago and still not handled. New requests in total: ${f.base ?? 0}.`,
      }[lang];
    case 'UNFINISHED_NO_NEXT':
      return {
        uk: `Частину плану лікування виконано, остання робота — щонайменше ${s.windowDays} дн. тому (у межах ${f.lookbackDays ?? 180} дн.), невиконані позиції лишилися, а майбутнього запису й активного нагадування немає.`,
        ru: `Часть плана лечения выполнена, последняя работа — не меньше ${s.windowDays} дн. назад (в пределах ${f.lookbackDays ?? 180} дн.), невыполненные позиции остались, а будущей записи и активного напоминания нет.`,
        en: `Part of the treatment plan is done, the last work at least ${s.windowDays} days ago (within ${f.lookbackDays ?? 180} days), open items remain, and there is no future visit and no active reminder.`,
      }[lang];
    case 'NO_REBOOK':
      return {
        uk: `Візит скасовано або пропущено за ${p} (щонайменше ${s.windowDays} дн. тому), і після нього немає ні завершеного візиту, ні майбутнього запису.`,
        ru: `Визит отменён или пропущен за ${p} (не меньше ${s.windowDays} дн. назад), и после него нет ни завершённого визита, ни будущей записи.`,
        en: `A visit was cancelled or missed in ${p} (at least ${s.windowDays} days ago), and after it there is neither a completed visit nor a future one.`,
      }[lang];
    case 'OVERDUE_TASKS':
      return {
        uk: `Відкриті завдання LANKA, термін яких минув; найдавніше прострочене на ${f.oldestDays ?? 0} дн.`,
        ru: `Открытые задачи LANKA, срок которых прошёл; самая давняя просрочена на ${f.oldestDays ?? 0} дн.`,
        en: `Open LANKA tasks past their due day; the oldest is ${f.oldestDays ?? 0} days overdue.`,
      }[lang];
    default:
      return {
        uk: `Останнє успішне завантаження: ${dateTime(f.lastSyncAt, lang)}. Поки дані старші за 48 год., сигнали за даними Cliniccards не розраховуються, а звіти показують дані на дату завантаження.`,
        ru: `Последняя успешная загрузка: ${dateTime(f.lastSyncAt, lang)}. Пока данные старше 48 ч., сигналы по данным Cliniccards не рассчитываются, а отчёты показывают данные на дату загрузки.`,
        en: `Last successful load: ${dateTime(f.lastSyncAt, lang)}. While the data is older than 48 h, the Cliniccards-based signals are not calculated and the reports show the data as of that load.`,
      }[lang];
  }
}

// One concrete recommended action
export function signalAction(kind: string, lang: SignalLang): string {
  return ({
    CANCEL_RATE: {
      uk: 'переглянути пропущені візити й доручити адміністратору зв’язатися з пацієнтами, які ще не записалися знову.',
      ru: 'просмотреть пропущенные визиты и поручить администратору связаться с пациентами, которые ещё не записались снова.',
      en: 'review the missed visits and ask the administrator to contact the patients who have not booked again.',
    },
    RETURN_DROP: {
      uk: 'переглянути розклад на найближчі дні й заповнити вільні вікна пацієнтами, які чекають на запис.',
      ru: 'просмотреть расписание на ближайшие дни и заполнить свободные окна пациентами, которые ждут записи.',
      en: 'review the schedule for the coming days and fill the free slots with patients waiting for a visit.',
    },
    PAYMENTS_DROP: {
      uk: 'відкрити звіт «Виручка» й перевірити, чи всі оплати за період внесено в Cliniccards.',
      ru: 'открыть отчёт «Выручка» и проверить, все ли оплаты за период внесены в Cliniccards.',
      en: 'open the “Revenue” report and check that every payment of the period is entered in Cliniccards.',
    },
    STALE_REQUESTS: {
      uk: 'відкрити заявки й обробити найстаріші або призначити відповідального.',
      ru: 'открыть заявки и обработать самые старые или назначить ответственного.',
      en: 'open the requests and handle the oldest ones or assign someone to them.',
    },
    UNFINISHED_NO_NEXT: {
      uk: 'переглянути список і доручити адміністратору запропонувати пацієнтам час для продовження лікування.',
      ru: 'просмотреть список и поручить администратору предложить пациентам время для продолжения лечения.',
      en: 'review the list and ask the administrator to offer the patients a time to continue the treatment.',
    },
    NO_REBOOK: {
      uk: 'переглянути список і доручити адміністратору запропонувати пацієнтам новий час.',
      ru: 'просмотреть список и поручить администратору предложить пациентам новое время.',
      en: 'review the list and ask the administrator to offer the patients a new time.',
    },
    OVERDUE_TASKS: {
      uk: 'відкрити завдання й виконати, перепризначити або закрити неактуальні.',
      ru: 'открыть задачи и выполнить, переназначить или закрыть неактуальные.',
      en: 'open the tasks and complete, reassign or close the ones no longer needed.',
    },
    SYNC_OVERDUE: {
      uk: 'перевірити підключення Cliniccards у налаштуваннях і запустити оновлення даних.',
      ru: 'проверить подключение Cliniccards в настройках и запустить обновление данных.',
      en: 'check the Cliniccards connection in the settings and start a data update.',
    },
  } as Record<string, Record<SignalLang, string>>)[kind]?.[lang] ?? '';
}

const origin = () => (process.env.WEB_ORIGIN ?? '').replace(/\/$/, '');
// The link carries only ids (the clinic, so another selected clinic is handled, and the event, so the page can say what the message showed)
export const signalUrl = (kind: string, clinicId: string, eventId?: string) => `${origin()}/signals/${kind}?c=${encodeURIComponent(clinicId)}${eventId ? `&e=${encodeURIComponent(eventId)}` : ''}`;

// The message of one event
// What got worse, compared with the base (the value of the last notice of this deviation, as of its time). A count is "more than", never "N new
// patients": the list itself may have changed.
const WORSE: Record<string, Record<SignalLang, string>> = {
  NO_REBOOK: { uk: 'Пацієнтів без повторного запису стало більше: {v} проти {b} станом на {at}.', ru: 'Пациентов без повторной записи стало больше: {v} против {b} на {at}.', en: 'More patients not rebooked: {v} against {b} as of {at}.' },
  UNFINISHED_NO_NEXT: { uk: 'Пацієнтів із незавершеним лікуванням без запису стало більше: {v} проти {b} станом на {at}.', ru: 'Пациентов с незавершённым лечением без записи стало больше: {v} против {b} на {at}.', en: 'More patients with unfinished treatment and no visit: {v} against {b} as of {at}.' },
  STALE_REQUESTS: { uk: 'Заявок, що довго чекають, стало більше: {v} проти {b} станом на {at}.', ru: 'Заявок, которые долго ждут, стало больше: {v} против {b} на {at}.', en: 'More requests waiting long: {v} against {b} as of {at}.' },
  OVERDUE_TASKS: { uk: 'Прострочених завдань стало більше: {v} проти {b} станом на {at}.', ru: 'Просроченных задач стало больше: {v} против {b} на {at}.', en: 'More overdue tasks: {v} against {b} as of {at}.' },
  CANCEL_RATE: { uk: 'Частка скасувань і неявок зросла: {v}% проти {b}% станом на {at} (+{d} п. п.).', ru: 'Доля отмен и неявок выросла: {v}% против {b}% на {at} (+{d} п. п.).', en: 'The share of cancellations and no-shows rose: {v}% against {b}% as of {at} (+{d} pp).' },
  RETURN_DROP: { uk: 'Падіння завершених візитів посилилося: на {v}% проти {b}% станом на {at} (+{d} п. п.).', ru: 'Падение завершённых визитов усилилось: на {v}% против {b}% на {at} (+{d} п. п.).', en: 'The drop in completed visits deepened: {v}% against {b}% as of {at} (+{d} pp).' },
  PAYMENTS_DROP: { uk: 'Падіння отриманих оплат посилилося: на {v}% проти {b}% станом на {at} (+{d} п. п.).', ru: 'Падение полученных оплат усилилось: на {v}% против {b}% на {at} (+{d} п. п.).', en: 'The drop in payments received deepened: {v}% against {b}% as of {at} (+{d} pp).' },
  SYNC_OVERDUE: { uk: 'Дані з Cliniccards не оновлювалися вже {v} год. — удвічі довше за поріг (сигнал був при {b} год. станом на {at}). Повторних нагадувань до успішного оновлення не буде.', ru: 'Данные из Cliniccards не обновлялись уже {v} ч. — вдвое дольше порога (сигнал был при {b} ч. на {at}). Повторных напоминаний до успешного обновления не будет.', en: 'Cliniccards data has not been updated for {v} h, twice the threshold (the signal was at {b} h as of {at}). No more reminders until a successful update.' },
};
const W2 = {
  uk: { worse: 'Ситуація погіршилася', listNote: 'Склад списку міг змінитися: це не кількість нових випадків.', rolling: 'Періоди ковзні: тоді — {then}, зараз — {now}; це не ті самі візити чи оплати.' },
  ru: { worse: 'Ситуация ухудшилась', listNote: 'Состав списка мог измениться: это не количество новых случаев.', rolling: 'Периоды скользящие: тогда — {then}, сейчас — {now}; это не те же визиты или оплаты.' },
  en: { worse: 'Things got worse', listNote: 'The list itself may have changed: this is not a number of new cases.', rolling: 'Rolling periods: then {then}, now {now}; not the same visits or payments.' },
};
const pct = (n: number, lang: SignalLang) => new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'uk-UA', { maximumFractionDigits: 1 }).format(n);

// The "worse" message: the clinic, what got worse against the base and when the base was, the current condition with its period, one action,
// the link to the details
function worseText(a: { clinic: string; kind: string; facts: SignalFacts & { base?: { from?: string | null; to?: string | null } | null }; settings: SignalSettings; prevValue?: number | null; prevAt?: Date | string | null; url: string }, lang: SignalLang): string {
  const t = L[lang];
  const w = W2[lang];
  const b = a.prevValue ?? 0;
  const lines = [`${a.clinic} · ${w.worse}`, '', fill(WORSE[a.kind]?.[lang] ?? '', { v: pct(a.facts.value, lang), b: pct(b, lang), at: dateTime(a.prevAt ?? undefined, lang), d: pct(a.facts.value - b, lang) }), '', condition(a.kind, a.facts, a.settings, lang)];
  const then = a.facts.base?.from && a.facts.base?.to ? period(a.facts.base.from, a.facts.base.to, lang) : null;
  const now = a.facts.from && a.facts.to ? period(a.facts.from, a.facts.to, lang) : null;
  if (then && now && then !== now) lines.push(fill(w.rolling, { then, now }));
  if (['NO_REBOOK', 'UNFINISHED_NO_NEXT', 'STALE_REQUESTS', 'OVERDUE_TASKS'].includes(a.kind)) lines.push(w.listNote);
  lines.push('', `${t.todo}: ${signalAction(a.kind, lang)}`, '', `${PATIENT_KINDS.includes(a.kind) ? t.patients : t.details} → ${a.url}`);
  return lines.join('\n');
}

export function eventText(a: { clinic: string; kind: string; type?: string; facts: SignalFacts; settings: SignalSettings; prevValue?: number | null; prevAt?: Date | string | null; url: string }, lang: SignalLang): string {
  if (a.type === 'WORSE') return worseText(a, lang);
  const t = L[lang];
  const lines = [`${a.clinic} · ${t.attention}`, '', headline(a.kind, a.facts, a.settings, lang), '', condition(a.kind, a.facts, a.settings, lang)];
  if (a.prevValue !== null && a.prevValue !== undefined && a.prevAt) lines.push(fill(t.prev, { at: dateTime(a.prevAt, lang), v: valueIn(a.kind, a.prevValue, lang) }));
  const act = signalAction(a.kind, lang);
  lines.push('', `${t.todo}: ${act}`, '', `${PATIENT_KINDS.includes(a.kind) ? t.patients : t.details} → ${a.url}`);
  return lines.join('\n');
}

// The push of a "worse" event: what got worse, in words only (no numbers, names or amounts)
export function pushWorse(kind: string, lang: SignalLang = 'uk') {
  return ({
    CANCEL_RATE: { uk: 'Більше скасувань і неявок', ru: 'Больше отмен и неявок', en: 'More cancellations and no-shows' },
    RETURN_DROP: { uk: 'Завершених візитів ще менше', ru: 'Завершённых визитов ещё меньше', en: 'Even fewer completed visits' },
    PAYMENTS_DROP: { uk: 'Отриманих оплат ще менше', ru: 'Полученных оплат ещё меньше', en: 'Even fewer payments received' },
    STALE_REQUESTS: { uk: 'Більше заявок чекають на обробку', ru: 'Больше заявок ждут обработки', en: 'More requests waiting' },
    UNFINISHED_NO_NEXT: { uk: 'Більше незавершеного лікування без запису', ru: 'Больше незавершённого лечения без записи', en: 'More unfinished treatment without a visit' },
    NO_REBOOK: { uk: 'Більше пацієнтів без повторного запису', ru: 'Больше пациентов без повторной записи', en: 'More patients not rebooked' },
    OVERDUE_TASKS: { uk: 'Більше прострочених завдань', ru: 'Больше просроченных задач', en: 'More overdue tasks' },
    SYNC_OVERDUE: { uk: 'Дані Cliniccards застаріли ще більше', ru: 'Данные Cliniccards устарели ещё больше', en: 'Cliniccards data is even older' },
  } as Record<string, Record<SignalLang, string>>)[kind]?.[lang] ?? 'LANKA';
}

// The push notification: the rule's name only, no numbers
export function pushTitle(kind: string, lang: SignalLang = 'uk') {
  return ({
    CANCEL_RATE: { uk: 'Скасування й неявки', ru: 'Отмены и неявки', en: 'Cancellations and no-shows' },
    RETURN_DROP: { uk: 'Менше завершених візитів', ru: 'Меньше завершённых визитов', en: 'Fewer completed visits' },
    PAYMENTS_DROP: { uk: 'Менше отриманих оплат', ru: 'Меньше полученных оплат', en: 'Fewer payments received' },
    STALE_REQUESTS: { uk: 'Заявки чекають на обробку', ru: 'Заявки ждут обработки', en: 'Requests are waiting' },
    UNFINISHED_NO_NEXT: { uk: 'Незавершене лікування без запису', ru: 'Незавершённое лечение без записи', en: 'Unfinished treatment without a visit' },
    NO_REBOOK: { uk: 'Пацієнти без повторного запису', ru: 'Пациенты без повторной записи', en: 'Patients not rebooked' },
    OVERDUE_TASKS: { uk: 'Прострочені завдання', ru: 'Просроченные задачи', en: 'Overdue tasks' },
    SYNC_OVERDUE: { uk: 'Дані Cliniccards застаріли', ru: 'Данные Cliniccards устарели', en: 'Cliniccards data is old' },
  } as Record<string, Record<SignalLang, string>>)[kind]?.[lang] ?? 'LANKA';
}

// "Current state of signals": the same measurements as the section, as one text (preview, and sent to oneself only on request)
export function overviewText(a: { clinic: string; at: Date; url: string; signals: { kind: string; state: string; active: boolean; facts?: SignalFacts; settings: SignalSettings }[] }, lang: SignalLang): string {
  const t = L[lang];
  const on = a.signals.filter((s) => s.active);
  const fired = on.filter((s) => s.state === 'fired' && s.facts);
  const ok = on.filter((s) => s.state === 'ok').length;
  const pending = on.length - fired.length - ok;
  const lines = [`${a.clinic} · ${t.current}`, dateTime(a.at, lang), ''];
  if (fired.length) {
    lines.push(`${t.fired}: ${fired.length}`);
    for (const s of fired) lines.push(`• ${headline(s.kind, s.facts!, s.settings, lang)}`);
  } else lines.push(t.none);
  lines.push('', `${t.ok}: ${ok}`);
  if (pending) lines.push(`${t.pending}: ${pending}`);
  if (a.signals.length - on.length) lines.push(`${t.off}: ${a.signals.length - on.length}`);
  lines.push('', `${t.open} → ${a.url}`);
  return lines.join('\n');
}
