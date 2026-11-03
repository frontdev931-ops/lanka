// Message scenarios for patients. Service ones relate to an appointment already made: a reminder, a no-show.
// Marketing ones invite the patient to come back and need the patient's consent (field consent = GIVEN).
// The text has no medical details: the message goes through a third-party messenger.
export type Kind = 'service' | 'marketing';

export interface Scenario {
  key: string;
  kind: Kind;
  defaultParams: Record<string, unknown>;
  defaultText: string;
}

export const SCENARIOS: Scenario[] = [
  {
    key: 'visit-reminder',
    kind: 'service',
    defaultParams: { hoursBefore: [24], confirmButtons: false },
    defaultText: 'Вітаємо, {name}! Нагадуємо про візит {date} о {time}. Клініка «{clinic}». Якщо плани змінилися, повідомте нас, будь ласка.',
  },
  {
    key: 'no-show',
    kind: 'service',
    defaultParams: {},
    defaultText: '{name}, ми не дочекалися вас {date}. Підкажіть, коли вам зручно прийти? Клініка «{clinic}».',
  },
  {
    key: 'hygiene-recall',
    kind: 'marketing',
    defaultParams: { months: 6 },
    defaultText: '{name}, минуло {months} міс. після вашої останньої гігієни. Запрошуємо на профілактику! Клініка «{clinic}».',
  },
  {
    key: 'cancel-followup',
    kind: 'service',
    defaultParams: {},
    defaultText: '{name}, ми бачимо, що візит {date} скасовано чи перенесено, а нової дати ще немає. Підкажіть, коли вам зручно прийти? Клініка «{clinic}».',
  },
  {
    key: 'post-visit-thanks',
    kind: 'service',
    defaultParams: {},
    defaultText: '{name}, дякуємо, що завітали до клініки «{clinic}». Якщо після візиту з’являться запитання, напишіть нам.',
  },
  {
    key: 'visit-review',
    kind: 'service',
    defaultParams: {},
    defaultText: '{name}, дякуємо, що були в клініці «{clinic}». Оцініть, будь ласка, візит від 1 до 5: це допомагає нам ставати кращими.',
  },
  {
    key: 'continue-treatment',
    kind: 'marketing',
    defaultParams: { days: 30 },
    defaultText: '{name}, у вас є незавершене лікування в клініці «{clinic}». Запрошуємо записатися на наступний візит.',
  },
  {
    key: 'lapsed',
    kind: 'marketing',
    defaultParams: { days: 180 },
    defaultText: '{name}, давно не бачили вас у клініці «{clinic}». Запрошуємо на візит, будемо раді вас бачити!',
  },
  {
    key: 'birthday',
    kind: 'marketing',
    defaultParams: {},
    defaultText: '{name}, вітаємо вас з днем народження! Гарного дня й усмішки від команди клініки «{clinic}».',
  },
];

export const scenario = (key: string) => SCENARIOS.find((s) => s.key === key);

const nameOf = (full: string) => {
  const parts = full.trim().split(/\s+/);
  // In Cliniccards the surname comes first: we address by the first name (the second word) if there is one
  return parts[1] ?? parts[0] ?? '';
};

export function render(template: string, vars: { fullName: string; clinic: string; date?: string; time?: string; months?: number }) {
  return template
    .replace(/\{name\}/g, nameOf(vars.fullName))
    .replace(/\{clinic\}/g, vars.clinic)
    .replace(/\{date\}/g, vars.date ?? '')
    .replace(/\{time\}/g, vars.time ?? '')
    .replace(/\{months\}/g, String(vars.months ?? ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}
