import { incomingHandoff, isUrgentSymptom } from '../src/ai/guardrails';

// The classifier of the working bot (and of the agent's draft): a complaint of pain goes to a person or an urgent request; the words "more" /
// "most" (більше, больше, найбільше) contain "біль"/"боль" and must not
describe('медичний класифікатор: «біль» лише як слово, «більше» — ні', () => {
  const notMedical = [
    'Мене більше цікавить лікування',
    'Ні, мене більше цікавить лікування, ніж гігієна',
    'Хочу найбільше зекономити час',
    'Скажіть, будь ласка, більше про консультацію',
    'Больше интересует лечение',
    'Меня больше интересует консультация, чем гигиена',
    'Мне нужно больше информации',
  ];
  const medical = [
    'У мене біль',
    'Сильний біль у зубі',
    'Сильний біль',
    'болить зуб',
    'У мене болить зуб уже третій день',
    'Болить зуб, що робити?',
    'Сильная боль в зубе',
    'болит зуб',
    'У меня болит зуб',
    'Є болі в щелепі',
    'Мучают боли по ночам',
  ];
  it('«більше / больше / найбільше» не є скаргою на біль', () => {
    for (const t of notMedical) expect([t, incomingHandoff(t, true)]).toEqual([t, null]);
    for (const t of notMedical) expect([t, isUrgentSymptom(t, true)]).toEqual([t, false]);
  });
  it('реальні скарги на біль розпізнаються й далі (українською та російською), у будь-якому регістрі', () => {
    for (const t of medical) expect([t, incomingHandoff(t, true)]).toEqual([t, 'medical']);
    for (const t of ['БІЛЬ у зубі', 'Біль', 'БОЛИТ ЗУБ']) expect([t, incomingHandoff(t, true)]).toEqual([t, 'medical']);
  });
  it('гострий симптом без питань про ліки лишається терміновим запитом, питання про ліки — передачею', () => {
    expect(isUrgentSymptom('Сильний біль у зубі', true)).toBe(true);
    expect(isUrgentSymptom('болить зуб', true)).toBe(true);
    expect(isUrgentSymptom('Сильная боль в зубе', true)).toBe(true);
    expect(isUrgentSymptom('Болить зуб, який антибіотик пити?', true)).toBe(false);
    expect(incomingHandoff('Болить зуб, який антибіотик пити?', true)).toBe('medical');
  });
  it('інші теми й слова, що містять «біль» усередині, поводяться як раніше', () => {
    expect(incomingHandoff('Скільки коштує консультація?', true)).toBeNull();
    expect(incomingHandoff('Є знижка?', true)).toBe('price');
    expect(incomingHandoff('Подам скаргу', true)).toBe('complaint');
    expect(incomingHandoff('Кров з ясен', true)).toBe('medical');
    expect(incomingHandoff('Підвищилась температура', true)).toBe('medical');
  });
});

describe('медичний класифікатор: «швидко», «покров» — не медицина; швидка допомога й кров — так', () => {
  it('«швидко / швидкий / покров» не є скаргою', () => {
    for (const t of ['Швидко можна записатися?', 'Хочу швидкий запис', 'Мені потрібна швидка відповідь', 'Покров', 'Покрови на кріслі чисті?', 'Быстро можно записаться?', 'Кровать у вас є?']) expect([t, incomingHandoff(t, true)]).toEqual([t, null]);
  });
  it('швидка допомога, виклик швидкої, кров, «скорая» — медичні як і раніше', () => {
    for (const t of ['Потрібна швидка допомога', 'Викличте швидку', 'Мені потрібна швидку допомогу', 'Из десны идёт кровь', 'Кров з ясен', 'Нужна скорая', 'Кровотеча не зупиняється', 'Кровит десна']) expect([t, incomingHandoff(t, true)]).toEqual([t, 'medical']);
  });
  it('«таблетки від страху» лишаються питанням про препарати', () => {
    expect(incomingHandoff('Чи є таблетки від страху?', true)).toBe('medical');
    expect(incomingHandoff('Можна випити заспокійливі таблетки перед візитом?', true)).toBe('medical');
  });
});
