// Границы ИИ-помощника, которые проверяет код, а не только инструкция модели.
// 1) входящее сообщение с опасной темой не доходит до модели вообще: сразу передача человеку;
// 2) готовый ответ проверяется на то, чего помощник говорить не должен.

export const HANDOFF_TEXT = 'Передаю ваше запитання адміністратору клініки, він відповість найближчим часом.';
export const HANDOFF_TEXT_RU = 'Передаю ваш вопрос администратору клиники, он ответит в ближайшее время.';

// Язык пациента по буквам: і ї є ґ — украинский, ы э ъ ё — русский; непонятно — украинский
export function isRussian(patientText: string): boolean {
  if (/[іїєґ]/i.test(patientText)) return false;
  if (/[ыэъё]/i.test(patientText)) return true;
  return /(здравствуйте|привет|можно|нужно|сколько|почему|спасибо|пожалуйста|меня|мне|стоит|записаться|когда|есть ли|ещё|чтобы|можете)/i.test(patientText);
}

export function handoffText(patientText: string): string {
  return isRussian(patientText) ? HANDOFF_TEXT_RU : HANDOFF_TEXT;
}
export type HandoffReason = 'medical' | 'price' | 'complaint' | 'long' | 'reply_check' | 'model';

const TOPICS: { reason: HandoffReason; re: RegExp }[] = [
  // здоровье: симптомы, лекарства, диагнозы — только врач или администратор
  { reason: 'medical', re: /(біль|болить|болю|болят|боль|болит|кров|кровит|кровь|температур|набряк|отек|отёк|опух|пухлин|флюс|антибіот|антибиот|таблетк|ліки|лекарств|препарат|дозуван|дозировк|алерг|вагітн|беремен|діагноз|диагноз|нестерпн|невыносим|швидк|скорая|нагноє|гній|гной)/i },
  // деньги: цены не называем, их знает администратор
  { reason: 'price', re: /(скільки\s+кошт|сколько\s+стоит|ціна|цена|цены|ціни|вартість|стоимость|прайс|знижк|скидк|розстрочк|рассрочк|кредит)/i },
  // жалобы и угрозы
  { reason: 'complaint', re: /(скарг|скарж|жалоб|жалу|пожалу|обман|поверніть\s+гроші|верните\s+деньги|прокурор|юрист|адвокат|суд[іуо]|поліці|полици|відгук\s+напишу|отзыв\s+напишу)/i },
];

// Discounts and instalments are never answered by the AI. A plain price question goes to the model only when the clinic has
// approved, recently confirmed prices (then the reply is checked against exactly those amounts).
const PRICE_ONLY_CASH = /(знижк|скидк|розстрочк|рассрочк|кредит|акці|акци)/i;

export function incomingHandoff(text: string, pricesKnown = false): HandoffReason | null {
  for (const t of TOPICS) {
    if (!t.re.test(text)) continue;
    if (t.reason === 'price' && pricesKnown && !PRICE_ONLY_CASH.test(text)) continue;
    return t.reason;
  }
  return null;
}

// Что нельзя в ответе клиники: суммы, дозировки, лекарства, диагнозы, советы по лечению
const MONEY = /(\d[\d\s]*(?:[.,]\d+)?)\s*(грн|₴|uah|usd|\$|€|грив|гривен|долар)/gi;
const BAD_REPLY = [
  /\d+\s*(мг|mg|мл|ml|табл)/i,
  /(діагноз|диагноз|антибіот|антибиот|ібупрофен|ибупрофен|парацетамол|нурофен|анальгін|анальгин|полощіть|полоскайте|приймайте|принимайте|прийміть|прикладіть|приложите)/i,
];

// allowedAmounts: the prices (UAH) the clinic approved and recently confirmed; any other amount in the reply is a violation
export function replyViolates(reply: string, allowedAmounts: number[] = []): boolean {
  for (const m of reply.matchAll(MONEY)) {
    const n = Number(m[1].replace(/\s/g, '').replace(',', '.'));
    if (!/грн|₴|uah|грив/i.test(m[2]) || !allowedAmounts.includes(n)) return true;
  }
  return BAD_REPLY.some((re) => re.test(reply));
}

// Модель просят вернуть JSON; всё, что не разобралось, считается передачей человеку
export interface ModelOption {
  date: string;
  time: string;
  doctor?: string;
}
export interface ModelReply {
  intent: string;
  reply: string;
  summary: string | null;
  options: ModelOption[];
}

export function parseModelJson(raw: string): ModelReply | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { intent?: unknown; reply?: unknown; summary?: unknown; options?: unknown };
    if (typeof j.intent !== 'string' || typeof j.reply !== 'string' || !j.reply.trim()) return null;
    const options = Array.isArray(j.options)
      ? j.options.filter((o): o is ModelOption => !!o && typeof (o as ModelOption).date === 'string' && typeof (o as ModelOption).time === 'string').map((o) => ({ date: o.date, time: o.time, ...(typeof o.doctor === 'string' && o.doctor.trim() ? { doctor: o.doctor.trim() } : {}) }))
      : [];
    return { intent: j.intent, reply: j.reply.trim().slice(0, 900), summary: typeof j.summary === 'string' && j.summary.trim() ? j.summary.trim().slice(0, 300) : null, options };
  } catch {
    return null;
  }
}

// Время в ответе (чч:мм) должно лежать в одном из свободных окон, которые мы сами посчитали по расписанию.
// Окна приходят в минутах от начала суток. Без окон называть время вообще нельзя.
export function timesOutsideWindows(reply: string, windows: [number, number][]): boolean {
  for (const m of reply.matchAll(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g)) {
    const t = Number(m[1]) * 60 + Number(m[2]);
    if (!windows.some(([a, b]) => t >= a && t <= b)) return true;
  }
  return false;
}
