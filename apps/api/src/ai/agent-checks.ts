// Checks of the model's FREE text in the agent's draft that are about wording and honesty of the next step (not about facts): each returns what it found or null.
// They are patterns, not language understanding: they refuse a bad answer so that the model writes it again with the exact reason; they never rewrite the text.

const SENTENCES = /(?<=[.!?…])\s+|\n+/;

// The inner working of the product in the client's text: "the system will show the sum", "the price is in a separate line below"
const MECHANISM = [
  /(?<![\p{L}])систем\p{L}*\s+(?:покаж\p{L}*|напиш\p{L}*|допиш\p{L}*|підбер\p{L}*|виведе\p{L}*|додас\p{L}*|показыва\p{L}*|напишет|допишет|подберет|покажет)/iu,
  /(?:суму|сумму|цін\p{L}*|цен\p{L}*|вартіст\p{L}*|стоимост\p{L}*)[^.!?…\n]{0,40}(?:покаж\p{L}*|покажет|буде\s+(?:в|у|на)\s+(?:окрем|наступн|рядк)|будет\s+(?:в|на)\s+(?:отдельн|следующ|строк))/iu,
  /(?:окрем\p{L}*|наступн\p{L}*|отдельн\p{L}*|следующ\p{L}*)\s+(?:рядк\p{L}*|строк\p{L}*)/iu,
  /(?:рядк\p{L}*|строк\p{L}*)\s+(?:нижче|ниже)/iu,
];
export function mechanismMention(text: string): string | null {
  for (const re of MECHANISM) {
    const m = re.exec(text);
    if (m) return m[0].slice(0, 40);
  }
  return null;
}

// A promise or a statement that the action is DONE, in a text whose next action is NOT that action. An invitation ("якщо хочете, можемо підібрати час",
// "можу підказати, як записатися") is fine: it is conditional or modal. "Вже підібрали час", "запис оформлено", "передали адміністратору", "зараз підберемо час" are not.
const DONE = /(?<![\p{L}])(?:вже\s+|уже\s+)?(?:підібрал\p{L}*|подобрал\p{L}*|записал\p{L}*|оформил\p{L}*|створил\p{L}*|зарезервувал\p{L}*|забронювал\p{L}*|забронировал\p{L}*|передал\p{L}*|передан\p{L}*|переданий|зроблен\p{L}*|створен\p{L}*|оформлен\p{L}*)(?![\p{L}])/iu;
const COMMIT = /(?<![\p{L}])(?:підберемо|підберу|запишемо|запишу|передамо|передам|зв['’ʼ]яжемося|зателефонуємо|подберём|подберем|запишем|передадим|свяжемся|перезвоним)(?![\p{L}])/iu;
const CONDITIONAL = /(?<![\p{L}])(?:якщо|коли|можемо|можу|можна|захочете|хочете|бажаєте|за\s+бажанням|если|можем|могу|можно|захотите|хотите|желаете|за\s+потреби|при\s+потребі)(?![\p{L}])/iu;
// bookingConfirmed: the system's own record says that a visit was created and confirmed: a sentence about THAT booking ("запис підтверджено", "ми вас записали") is a fact,
// not a promise; a hand-over or "we found a time" is still never said as done.
const ABOUT_BOOKING = /(?<![\p{L}])(?:запис\p{L}*|записал\p{L}*|записан\p{L}*|оформлен\p{L}*|підтверджен\p{L}*|подтвержден\p{L}*|створен\p{L}*|запись|записи)(?![\p{L}])/iu;
const NOT_THAT = /(?<![\p{L}])(?:передал\p{L}*|передан\p{L}*|передамо|передам|підібрал\p{L}*|подобрал\p{L}*)(?![\p{L}])/iu;
export function actionPromise(text: string, bookingConfirmed = false): string | null {
  for (const sentence of text.split(SENTENCES)) {
    if (bookingConfirmed && ABOUT_BOOKING.test(sentence) && !NOT_THAT.test(sentence)) continue;
    const done = DONE.exec(sentence);
    if (done && !/(?<![\p{L}])не\s+/iu.test(sentence.slice(Math.max(0, done.index - 12), done.index))) return done[0];
    const commit = COMMIT.exec(sentence);
    if (commit && !CONDITIONAL.test(sentence)) return commit[0];
  }
  return null;
}

// QUALITY FLAG for the evaluation, never a refusal: a service title written in the middle of a sentence with a capital letter AND in another form than the approved one ("У Тестову консультацію входять…").
// A lower-case inflected use ("вартість тестової консультації") is natural and is left alone; only a capitalised, changed title is refused.
export function inflectedTitle(text: string, titles: string[]): string | null {
  for (const title of [...new Set(titles)]) {
    const words = title.split(/\s+/).filter((w) => w.length >= 3);
    if (words.length < 2) continue;
    // the stem of each word: its beginning without the changing ending (an adjective changes its ending at the 5th letter: Тестова / Тестову)
    const stem = (w: string) => w.slice(0, Math.max(4, w.length - 3));
    // only the FIRST word carries the capital letter (the title as the clinic wrote it: "Тестова консультація")
    const pattern = words.map((w, i) => `${i === 0 ? stem(w)[0].toUpperCase() : stem(w)[0].toLowerCase()}${stem(w).slice(1).toLowerCase()}\\p{L}*`).join('\\s+');
    for (const m of text.matchAll(new RegExp(pattern, 'gu'))) if (m[0] !== title) return m[0];
  }
  return null;
}
