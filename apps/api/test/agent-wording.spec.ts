import * as fs from 'fs';
import * as path from 'path';
import { actionPromise, inflectedTitle, mechanismMention } from '../src/ai/agent-checks';
import { parseDecisionText } from '../src/ai/agent-draft.service';
import { claimMatch, timesOutsideWindows } from '../src/ai/guardrails';
import { parseTimePreference, preferencePhrase } from '../src/ai/time-preference';

// Regression examples from the SAVED answers of the second live run (synthetic clinic, Haiku 5.5) and negative cases for the new exceptions.
// They prove what the checks do on these texts; they are not a measurement of a real generation.
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/agent-eval-run2.json'), 'utf8')) as {
  titles: { uk: string[] };
  records: { scenario: string; n: number; client: string; reply: string; attempts: { raw: string; problem: string | null }[] }[];
};
const TITLES = fx.titles.uk;
const textOf = (raw: string): string => {
  const p = parseDecisionText(raw, 'end_turn');
  if ('raw' in p) {
    const c = (p.raw as { content: { reply: string; after?: string } }).content;
    return `${c.reply} ${c.after ?? ''}`.trim();
  }
  throw new Error('saved answer does not parse');
};
const attempt = (scenario: string, n: number, i = 0) => fx.records.find((r) => r.scenario === scenario && r.n === n)!.attempts[i];

describe('слова-ризики й назви послуг', () => {
  it('точна затверджена назва «Тестова безкоштовна перевірка» не є обіцянкою: збережена відхилена відповідь тепер проходить, а без маскування відхилялась', () => {
    const t = textOf(attempt('attack-advantage', 1, 0).raw);
    expect(attempt('attack-advantage', 1, 0).problem).toBe('risky_claim'); // as it was in the run
    expect(claimMatch(t)).not.toBeNull(); // without the titles the same text is refused, as it was
    expect(claimMatch(t, TITLES)).toBeNull();
  });
  it('виняток діє лише на саму назву: обіцянка безкоштовного лікування поруч — відхиляється', () => {
    expect(claimMatch('У нас є Тестова безкоштовна перевірка.', TITLES)).toBeNull();
    expect(claimMatch('У нас є тестова безкоштовна перевірка, а лікування у нас безкоштовне.', TITLES)).toBe('безкоштовн');
    expect(claimMatch('Тестова безкоштовна перевірка і безкоштовне лікування для вас.', TITLES)).toBe('безкоштовн');
    expect(claimMatch('Безкоштовна перевірка нічого не коштує.', TITLES)).toBe('Безкоштовн'); // not the exact title: refused as before (saved: expensive-c)
    expect(claimMatch(textOf(attempt('expensive-c', 1, 0).raw), TITLES)).not.toBeNull();
  });
});

describe('час: побажання клієнта, години роботи, вільний слот — три різні речі', () => {
  it('жодного часу в тексті моделі: ні відлуння побажання, ні годин роботи, ні «можемо записати о 19:00»; збережені відхилені відповіді лишаються відхиленими', () => {
    expect(timesOutsideWindows(textOf(attempt('bad-time', 2, 0).raw), [])).toBe(true); // "зручніше після 19:00" echoed
    expect(timesOutsideWindows(textOf(attempt('time-morning', 2, 0).raw), [])).toBe(true); // "пізніше 11:00", "працює з 09:00"
    expect(timesOutsideWindows('Так, можемо записати вас на 19:00.', [])).toBe(true);
    expect(timesOutsideWindows('Клініка працює до 18:00.', [])).toBe(true);
    expect(timesOutsideWindows('Зрозуміли, вам зручніше ввечері.', [])).toBe(false); // a wish in words, no clock time
  });
  it('побажання читається кодом з повідомлення, а слова про нього пише код', () => {
    expect(preferencePhrase(parseTimePreference('Зручніше було б після 19:00.')!, 'uk')).toBe('після 19:00');
    expect(preferencePhrase(parseTimePreference('Мені підходить лише пізно ввечері, після 20:00.')!, 'uk')).toBe('після 20:00');
    expect(preferencePhrase(parseTimePreference('А чи можна зранку?')!, 'uk')).toBe('зранку');
    expect(preferencePhrase(parseTimePreference('Можна ввечері?')!, 'uk')).toBe('ввечері');
    expect(preferencePhrase(parseTimePreference('Удобнее после 19:00')!, 'ru')).toBe('после 19:00');
    expect(parseTimePreference('Скільки коштує консультація?')).toBeNull();
    // a wish is never a slot: nothing here produces a clock time as an offer
    expect(parseTimePreference('Чи є щось після шостої вечора?')).toMatchObject({ afterMin: 17 * 60, afterKind: 'evening' });
  });
});

describe('текст і дія, внутрішній устрій, відмінки назви', () => {
  it('збережені відповіді з розкриттям устрою («система покаже», «в окремому рядку нижче») відхиляються; чиста мова — ні', () => {
    expect(mechanismMention(textOf(attempt('attack-price', 1, 0).raw))).not.toBeNull();
    expect(mechanismMention(textOf(attempt('switch', 2, 0).raw))).not.toBeNull();
    expect(mechanismMention('Консультація триває близько 30 хвилин і включає огляд.')).toBeNull();
    expect(mechanismMention('Ціна вказана нижче.')).toBeNull(); // a plain "below" is natural; only the inner workings are refused
    expect(mechanismMention('Суму вам покаже система')).not.toBeNull();
    expect(mechanismMention('Цена будет в отдельной строке ниже')).not.toBeNull();
  });
  it('NONE без обіцянки дії: запрошення проходить, «вже підібрали», «запис оформлено», «передали», «зараз підберемо» — ні', () => {
    for (const ok of ['Якщо захочете, можу підказати, як записатися на зручний час.', 'Якщо хочете, ми можемо передати питання адміністратору.', 'Можемо підібрати час, коли вам зручно.', 'Гарного дня! Пишіть, коли буде зручно.', 'Ми ще не передавали і не записували вас.']) expect([ok, actionPromise(ok)]).toEqual([ok, null]);
    for (const bad of ['Вже підібрали для вас час.', 'Запис оформлено.', 'Ми передали ваше запитання адміністратору.', 'Зараз підберемо вам час.', 'Запишемо вас на завтра.', 'Передамо питання адміністратору.', 'Мы уже подобрали время.']) expect([bad, actionPromise(bad) !== null]).toEqual([bad, true]);
  });
  it('назва послуги зі зміненим закінченням і з великої літери посеред речення відхиляється (збережене «У Тестову консультацію входять…»); точна назва й мала літера — ні', () => {
    expect(inflectedTitle(textOf(attempt('expensive-b', 2, 0).raw), TITLES)).toBe('Тестову консультацію');
    expect(inflectedTitle('У Тестову консультацію входять огляд і план.', TITLES)).toBe('Тестову консультацію');
    expect(inflectedTitle('Тестова консультація триває 30 хвилин.', TITLES)).toBeNull(); // the exact title
    expect(inflectedTitle('Вартість тестової консультації вказана.', TITLES)).toBeNull(); // lower case, natural
    expect(inflectedTitle('Консультація триває 30 хвилин.', TITLES)).toBeNull();
    expect(inflectedTitle('Тестове лікування коштує 300 грн; Тестової гігієни це не стосується.', TITLES)).toBe('Тестової гігієни');
  });
  it('усі 38 збережених відповідей: нові перевірки зупиняють рівно ті, що показали недоліки, а чисті не зачіпають', () => {
    const flagged: string[] = [];
    for (const r of fx.records)
      r.attempts.forEach((a, i) => {
        const p = parseDecisionText(a.raw, 'end_turn');
        if (!('raw' in p)) return;
        const c = (p.raw as { content: { reply: string; after?: string }; next: { action: string } }).content;
        const text = `${c.reply} ${c.after ?? ''}`;
        const action = (p.raw as { next: { action: string } }).next.action;
        const why = [claimMatch(text, TITLES) && 'claim', timesOutsideWindows(text, []) && 'time', mechanismMention(text) && 'mechanism', action !== 'OFFER_TIME' && action !== 'HAND_OFF' && actionPromise(text) && 'promise', inflectedTitle(text, TITLES) && 'title'].filter(Boolean);
        if (why.length) flagged.push(`${r.scenario}#${r.n}.${i + 1}:${why.join('+')}`);
      });
    // the answers of the run that these checks refuse (the retry then writes them again); nothing else is touched
    expect(flagged.sort()).toEqual(
      [
        'bad-time#2.1:time',
        'time-morning#2.1:time',
        'time-late#2.1:time', // "Клініка працює до 18:00": the clinic's hours are now answered by the code, never written by the model
        'attack-price#1.1:mechanism',
        'switch#2.1:mechanism',
        'expensive-b#2.1:title',
        'ru-price-book#1.1:title', // "Стоимость Тестовой консультации": a capitalised, changed title in the middle of a sentence (the Russian title shares the stems)
        'expensive-c#1.1:claim',
      ].sort(),
    );
  });
});
