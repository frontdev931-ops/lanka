import { createHash } from 'crypto';
import { ConversationVisit } from '../ai/booking-status';

// The agent's cancellation of a visit THIS dialogue created (the first slice; see agent-administrator.md section 45): the patient's words that ask for it, the
// question with its own buttons, the texts of the code, the reference for the staff. Rescheduling and any other visit stay a staff task.

// "cancel" in Ukrainian and Russian (not "відмінно" / "отменный", which mean "excellent"); a wish to MOVE the visit is not a cancellation
const CANCEL_WORD = /(?<![\p{L}])(?:скасу\p{L}*|скасов\p{L}*|відмін(?:и|іть|ити|ити\p{L}*|а|у|яю|ю)|анулю\p{L}*|отмен(?:а|у|ы|е|ить|ите|им|ю|яю|ять|ял\p{L}*)|отмін(?:а|у|ити|іть)|cancel\p{L}*)(?![\p{L}])/iu;
const NOT_CANCEL = /(?<![\p{L}])не\s+(?:скасо|скасу|відмін|отмен)/iu;
const MOVE_WORD = /(?<![\p{L}])(?:перен[еіо]с\p{L}*|перенест\p{L}*|змін\p{L}*\s+(?:час|дат\p{L}*|день)|измен\p{L}*\s+(?:время|дат\p{L}*|день)|на\s+інш\p{L}*\s+(?:день|час|дату)|на\s+друг\p{L}*\s+(?:день|время|дату))(?![\p{L}])/iu;
export const asksToCancel = (text: string): boolean => !text.startsWith('Обрав час:') && CANCEL_WORD.test(text) && !NOT_CANCEL.test(text) && !MOVE_WORD.test(text);

// The tapped button saved with the incoming message (IntakeService): which question it answers and how
export function cancelTapOf(buttons: unknown): { yes: boolean; askId: string } | null {
  const p = Array.isArray(buttons) ? (buttons as { payload?: unknown }[]).map((b) => b.payload).find((x): x is string => typeof x === 'string') : undefined;
  const m = p ? /^cancel(yes|no)\|([A-Za-z0-9]{10,40})$/.exec(p) : null;
  return m ? { yes: m[1] === 'yes', askId: m[2] } : null;
}

// The revision of the visit the question was asked about: a change of any of these (time, doctor, status in our copy) makes the question and its "yes" stale
export const cancelKeyOf = (v: ConversationVisit): string => createHash('sha256').update([v.requestId, v.externalVisitId, v.startsAt.toISOString(), v.doctorId ?? '', v.status].join('|')).digest('hex').slice(0, 24);

// What is stored with the question (no contacts of the patient)
export interface CancelRef {
  visitId: string;
  externalVisitId: string;
  startsAt: string;
  doctorId: string | null;
  doctor: string | null;
  service: string | null;
  date: string;
  time: string;
  askId?: string;
}
export const cancelRefOf = (v: ConversationVisit): CancelRef => ({ visitId: v.visitId, externalVisitId: v.externalVisitId, startsAt: v.startsAt.toISOString(), doctorId: v.doctorId, doctor: v.doctor, service: v.service, date: v.date, time: v.time });

const what = (r: CancelRef, lang: 'uk' | 'ru') =>
  lang === 'ru' ? `${r.service ?? 'услуга'}${r.doctor ? `, врач ${r.doctor}` : ''}, ${r.date} в ${r.time}` : `${r.service ?? 'послуга'}${r.doctor ? `, лікар ${r.doctor}` : ''}, ${r.date} о ${r.time}`;

export const CANCEL_TEXT = {
  uk: {
    yes: 'Так, скасувати',
    no: 'Ні, залишити',
    ask: (r: CancelRef, repeat = false) => `${repeat ? 'Щоб скасувати запис, оберіть, будь ласка, відповідь кнопкою.\n' : ''}Ваш запис: ${what(r, 'uk')}.\nСкасувати цей запис?`,
    done: (r: CancelRef) => `Запис скасовано: ${what(r, 'uk')}. Якщо захочете записатися знову, напишіть нам.`,
    kept: (r: CancelRef) => `Добре, запис залишається без змін: ${what(r, 'uk')}.`,
    already: (r: CancelRef) => `Цей запис уже скасовано: ${what(r, 'uk')}.`,
    stale: 'Ця кнопка вже неактуальна, запис не змінено. Якщо хочете скасувати запис, напишіть про це, будь ласка.',
    // said only after the staff request exists, and only when nothing was written (refused before the write, or Cliniccards refused it)
    handed: 'Передали ваш запит на скасування адміністратору. Поки він його не опрацює, запис не змінено.',
  },
  ru: {
    yes: 'Да, отменить',
    no: 'Нет, оставить',
    ask: (r: CancelRef, repeat = false) => `${repeat ? 'Чтобы отменить запись, выберите, пожалуйста, ответ кнопкой.\n' : ''}Ваша запись: ${what(r, 'ru')}.\nОтменить эту запись?`,
    done: (r: CancelRef) => `Запись отменена: ${what(r, 'ru')}. Если захотите записаться снова, напишите нам.`,
    kept: (r: CancelRef) => `Хорошо, запись остаётся без изменений: ${what(r, 'ru')}.`,
    already: (r: CancelRef) => `Эта запись уже отменена: ${what(r, 'ru')}.`,
    stale: 'Эта кнопка уже неактуальна, запись не изменена. Если хотите отменить запись, напишите об этом, пожалуйста.',
    handed: 'Передали ваш запрос на отмену администратору. Пока он его не обработает, запись не изменена.',
  },
};

// The reference for the staff request: the booking request of the dialogue, the visit in Cliniccards, what it is, and why the agent did not cancel it itself
export const cancelStaffNote = (refs: { requestId: string; ref: CancelRef }[], reason: string): string =>
  `Пацієнт просить скасувати запис. ${refs.map((x) => `Заявка на запис ${x.requestId}, візит Cliniccards ${x.ref.externalVisitId}: ${what(x.ref, 'uk')}`).join('; ')}. Причина: ${reason}`;

// ---- moving a visit this dialogue created to another time (the same visit, service, doctor and length; section 46) ----

export const asksToMove = (text: string): boolean => !text.startsWith('Обрав час:') && MOVE_WORD.test(text) && !NOT_MOVE.test(text);
const NOT_MOVE = /(?<![\p{L}])не\s+(?:перен[еіо]с|змін|измен)/iu;

// The tapped button of a move question: the offered new time (slot), or the answer to the confirmation
export function moveTapOf(buttons: unknown): { kind: 'slot' | 'yes' | 'no'; id: string; date?: string; time?: string } | null {
  const p = Array.isArray(buttons) ? (buttons as { payload?: unknown }[]).map((b) => b.payload).find((x): x is string => typeof x === 'string') : undefined;
  const m = p ? /^move(slot|yes|no)\|([A-Za-z0-9]{10,40})(?:\|(\d{4}-\d{2}-\d{2})\|(\d{2}:\d{2}))?$/.exec(p) : null;
  if (!m || (m[1] === 'slot' && !m[3])) return null;
  return { kind: m[1] as 'slot' | 'yes' | 'no', id: m[2], ...(m[3] ? { date: m[3], time: m[4] } : {}) };
}

// The words of a confirmation button typed (or sent as plain text by a channel without buttons, desktop Instagram), in either language: which answer it is.
// Only the full words of a button count; a bare "так" / "да" never does.
const norm = (x: string) => x.trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
export function typedAnswer(text: string): 'cancelyes' | 'cancelno' | 'moveyes' | 'moveno' | null {
  const t = norm(text);
  for (const l of ['uk', 'ru'] as const) {
    if (t === norm(CANCEL_TEXT[l].yes)) return 'cancelyes';
    if (t === norm(CANCEL_TEXT[l].no)) return 'cancelno';
    if (t === norm(MOVE_TEXT[l].yes)) return 'moveyes';
    if (t === norm(MOVE_TEXT[l].no)) return 'moveno';
  }
  return null;
}

// The proposed new time, stored with the confirmation (date as the patient reads it, dd.mm.yyyy)
export interface MoveTo {
  startsAt: string;
  cabinetId: string;
  date: string;
  time: string;
}

const whatAt = (r: CancelRef, date: string, time: string, lang: 'uk' | 'ru') => what({ ...r, date, time }, lang);

export const MOVE_TEXT = {
  uk: {
    yes: 'Так, перенести',
    no: 'Ні, залишити як є',
    askTime: (r: CancelRef) => `Ваш запис: ${what(r, 'uk')}.\nНа який день і час вам зручно його перенести?`,
    offer: (r: CancelRef, gone = false) => `${gone ? 'На жаль, цей час уже недоступний. ' : ''}Ваш запис: ${what(r, 'uk')}.\nОберіть, будь ласка, новий час:`,
    confirm: (r: CancelRef, to: MoveTo, repeat = false) => `${repeat ? 'Щоб перенести запис, оберіть, будь ласка, відповідь кнопкою.\n' : ''}Перенести запис?\nЗараз: ${what(r, 'uk')}.\nНовий час: ${whatAt(r, to.date, to.time, 'uk')}.`,
    done: (r: CancelRef, to: MoveTo) => `Запис перенесено: ${whatAt(r, to.date, to.time, 'uk')}.`,
    kept: (r: CancelRef) => `Добре, запис залишається без змін: ${what(r, 'uk')}.`,
    stale: 'Ця кнопка вже неактуальна, запис не змінено. Якщо хочете перенести запис, напишіть про це, будь ласка.',
    handed: 'Передали ваш запит на перенесення адміністратору. Поки він його не опрацює, запис не змінено.',
  },
  ru: {
    yes: 'Да, перенести',
    no: 'Нет, оставить как есть',
    askTime: (r: CancelRef) => `Ваша запись: ${what(r, 'ru')}.\nНа какой день и время вам удобно её перенести?`,
    offer: (r: CancelRef, gone = false) => `${gone ? 'К сожалению, это время уже недоступно. ' : ''}Ваша запись: ${what(r, 'ru')}.\nВыберите, пожалуйста, новое время:`,
    confirm: (r: CancelRef, to: MoveTo, repeat = false) => `${repeat ? 'Чтобы перенести запись, выберите, пожалуйста, ответ кнопкой.\n' : ''}Перенести запись?\nСейчас: ${what(r, 'ru')}.\nНовое время: ${whatAt(r, to.date, to.time, 'ru')}.`,
    done: (r: CancelRef, to: MoveTo) => `Запись перенесена: ${whatAt(r, to.date, to.time, 'ru')}.`,
    kept: (r: CancelRef) => `Хорошо, запись остаётся без изменений: ${what(r, 'ru')}.`,
    stale: 'Эта кнопка уже неактуальна, запись не изменена. Если хотите перенести запись, напишите об этом, пожалуйста.',
    handed: 'Передали ваш запрос на перенос администратору. Пока он его не обработает, запись не изменена.',
  },
};

export const moveStaffNote = (refs: { requestId: string; ref: CancelRef }[], reason: string, to?: MoveTo): string =>
  `Пацієнт просить перенести запис. ${refs.map((x) => `Заявка на запис ${x.requestId}, візит Cliniccards ${x.ref.externalVisitId}: ${what(x.ref, 'uk')}`).join('; ')}${to ? `. Бажаний новий час: ${to.date} о ${to.time}` : ''}. Причина: ${reason}`;
