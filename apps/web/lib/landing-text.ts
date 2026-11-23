import type { Locale } from './i18n';

// Text of the public landing page (design of 2026-11-23, "dark accent"). Prices and limits repeat apps/api/src/service/plans.ts (PLANS,
// LAUNCH_FEE_UAH, AI_PACK, NETWORK_PRICE, BILLING_TERMS): change both together.
// Rules for this text:
//   - benefits are what LANKA lets a clinic do, never measured results (there are no validated conversion, savings or ROI figures); drawn screens
//     carry made-up demo data and are labelled as examples;
//   - the plan split agreed on 2026-11-23: the AI administrator replies on its own in Instagram, Telegram and Messenger on Start and Pro and prepares
//     a booking request; on Start the administrator enters it in Cliniccards, on Pro the AI books and reschedules visits in Cliniccards itself.
//     The product's plan gates (apps/api/src/service/plans.ts) and the controlled write-back must match this before the page is released;
//   - the AI answers only with what the clinic approved; medical questions, complaints and anything unusual go to a person;
//   - individual work (custom website work, other systems) is quoted separately; the website chat is not offered, website forms are.
// Channel marks: components/ChannelIcon.tsx
export type ChannelIconKey = 'cliniccards' | 'telegram' | 'instagram' | 'messenger' | 'email';

type Tone = 'ai' | 'warn' | 'ok' | 'neutral' | 'ig' | 'tg' | 'ms';

export interface LandingText {
  nav: { product: string; ai: string; launch: string; pricing: string; faq: string; login: string; demo: string; menu: string; terms: string; privacy: string };
  ui: { example: string; demoData: string };
  hero: {
    badgeNew: string;
    badge: string;
    title1: string;
    title2: string;
    sub: string;
    demo: string;
    discuss: string;
    // the app preview: a browser frame with the dashboard (demo data) and an Instagram conversation answered by the AI
    appUrl: string;
    stats: { label: string; value: string; delta: string; tone: 'ok' | 'warn' | 'neutral' }[];
    nowTitle: string;
    nowUpdated: string;
    now: { text: string; tag: string; tone: Tone }[];
    chat: { handle: string; status: string; time: string; in1: string; out1: string; in2: string; out2: string; slots: string[]; ai: string; input: string };
    floatReq: { t: string; d: string };
    floatSignal: string;
  };
  strip: { label: string; items: string[] };
  problem: { eyebrow: string; title1: string; title2: string; lead: string; rows: { when: string; loss: string; lossD: string; fixT: string; fixD: string; icon: 'ai' | 'back' | 'bell' }[] };
  product: {
    eyebrow: string;
    title1: string;
    title2: string;
    lead: string;
    hub: { sources: { key: 'web' | ChannelIconKey; name: string }[]; center: string; feedTitle: string; feed: { text: string; ch: string; tone: Tone }[]; points: string[] };
    inbox: { t: string; d: string; rows: { ini: string; name: string; text: string; tag: string; tone: Tone }[] };
    assistant: { t: string; q: string; rows: [string, number][]; note: string };
    report: { t: string; d: string; cols: [string, string]; rows: [string, string][]; btn: string };
    remind: { t: string; d: string; rules: string[] };
  };
  ai: { eyebrow: string; title1: string; title2: string; lead: string; stages: { t: string; d: string }[]; notes: string[]; modes: { k: string; t: string; d: string; accent?: boolean }[] };
  mid: { title1: string; title2: string; cta: string };
  team: {
    eyebrow: string;
    title: string;
    roles: { t: string; q: string; d: string }[];
    owner: { eyebrow: string; title: string; text: string; chips: string[]; chat: string; chatSub: string; digestT: string; digest: string[]; aiLine: string; signalT: string; signal: string; open: string };
  };
  launch: { eyebrow: string; title1: string; title2: string; lead: string; steps: { t: string; d: string }[] };
  pricing: {
    eyebrow: string;
    title: string;
    sub: string;
    monthly: string;
    yearly: string;
    yearBadge: string;
    yearNote: string;
    perMonth: string;
    perYear: string;
    // {sum}: the annual price, {save}: the saving against 12 monthly payments
    orYear: string;
    save: string;
    approx: string;
    best: string;
    // Start and Pro, in this order (the billing screen reuses name, lead and lines)
    plans: { name: string; price: string; year: string; full: string; save: string; perMonthYear: string; lead: string; aiT: string; aiTag: string; aiD: string; aiMeta: string; alsoT: string; lines: string[]; cta: string }[];
    compareT: string;
    compareCols: [string, string, string];
    // a cell: '✓', '—' or a short text; strong: the cell is a Pro advantage
    compare: { label: string; start: string; pro: string; strong?: boolean }[];
    pack: string;
    launchT: string;
    launchD: string;
    network: { name: string; d: string; price: string; cta: string };
  };
  trust: { eyebrow: string; title: string; items: { t: string; d: string }[] };
  faq: { eyebrow: string; title: string; more: string; moreLink: string; items: { q: string; a: string }[] };
  final: { title1: string; title2: string; text: string; demo: string; formT: string };
  // the "call me back" form (POST /contact-requests): a phone, an optional name, the consent; the demo is offered while waiting
  contact: { title: string; text: string; phone: string; name: string; consent: string; privacy: string; submit: string; sending: string; done: string; demoHint: string; demo: string; error: string; close: string };
  // the service owner's legal name (components/OwnerDetails.tsx holds the names)
  footer: { tagline: string; product: string; clients: string; docs: string; features: string; contact: string; copyright: string; owner: { title: string } };
}

const uk: LandingText = {
  nav: { product: 'Продукт', ai: 'ШІ-адміністратор', launch: 'Запуск', pricing: 'Тарифи', faq: 'Питання', login: 'Увійти', demo: 'Демо за хвилину', menu: 'Меню', terms: 'Умови', privacy: 'Конфіденційність' },
  ui: { example: 'Приклад', demoData: 'демо-дані' },
  hero: {
    badgeNew: 'Нове',
    badge: 'ШІ-адміністратор відповідає в Instagram',
    title1: 'Кожне звернення —',
    title2: 'у запис.',
    sub: 'ШІ відповідає пацієнтам у месенджерах навіть уночі, нагадує про візити й показує власнику, де клініка втрачає гроші. Поруч із Cliniccards — без переїзду.',
    demo: 'Відкрити демо — без реєстрації',
    discuss: 'Обговорити запуск',
    appUrl: 'app.lankaclinic.app · Головна · демо-дані',
    stats: [
      { label: 'Нові записи', value: '64', delta: '↑ було 58', tone: 'ok' },
      { label: 'Прийоми', value: '86', delta: 'за тиждень', tone: 'neutral' },
      { label: 'Неявки', value: '7', delta: '↑ було 5', tone: 'warn' },
    ],
    nowTitle: 'Потрібна дія зараз',
    nowUpdated: 'оновлено щойно',
    now: [
      { text: 'ШІ підготував заявку: гігієна, чт 14:30', tag: 'Instagram', tone: 'ai' },
      { text: '2 заявки чекають понад 4 години', tag: 'Сигнал', tone: 'warn' },
      { text: '12 пацієнтів без наступного запису', tag: 'Звіт', tone: 'ok' },
    ],
    chat: {
      handle: 'olena.k',
      status: 'Instagram · активна щойно',
      time: 'Сьогодні 23:12',
      in1: 'Скільки коштує чистка? Трохи боюся',
      out1: 'Розумію, так буває в багатьох. Скажіть про це лікарю на початку — він працюватиме у вашому темпі. Професійна гігієна — 1 400 грн. Підібрати зручний час?',
      in2: 'Так, у четвер',
      out2: 'Є вільні: чт 14:30 або 16:00',
      slots: ['14:30', '16:00'],
      ai: 'Відповідає ШІ-адміністратор LANKA',
      input: 'Повідомлення…',
    },
    floatReq: { t: 'Нова заявка на запис', d: 'о 23:12 · поки адміністратор спав' },
    floatSignal: 'Сигнал: неявки 27% ↑',
  },
  strip: { label: 'Працює з тим, що у вас уже є', items: ['Cliniccards', 'Instagram', 'Telegram', 'Messenger', 'Форми сайту', 'Excel і PDF'] },
  problem: {
    eyebrow: '01 — Де губляться пацієнти',
    title1: 'Клініка втрачає пацієнтів не в кріслі, а',
    title2: 'між повідомленнями.',
    lead: 'Три тихі ситуації, які щотижня трапляються майже в кожній клініці — і що з ними робить LANKA.',
    rows: [
      { when: '23:12', loss: 'Повідомлення в Instagram уночі', lossD: 'Відповідь зранку — пацієнт уже записався деінде.', fixT: 'З LANKA: ШІ відповідає одразу', fixD: 'Називає затверджену ціну, пропонує вільний час і готує заявку до ранку.', icon: 'ai' },
      { when: 'Пн', loss: 'Пацієнтка скасувала візит', lossD: 'Ніхто не передзвонив, і вона не повернулася.', fixT: 'З LANKA: вона в списку на дзвінок', fixD: 'Скасування без нового запису видно одразу, завдання адміністратору — в один клік.', icon: 'back' },
      { when: '30+ дн.', loss: 'Лікування почали, але не закінчили', lossD: 'Наступного запису немає, і про план ніхто не нагадав.', fixT: 'З LANKA: сигнал керівнику', fixD: 'Коли таких пацієнтів більше за поріг — повідомлення в службовий Telegram.', icon: 'bell' },
    ],
  },
  product: {
    eyebrow: '02 — Продукт',
    title1: 'Сайт, Instagram, Telegram, Messenger —',
    title2: 'в одному місці.',
    lead: 'Звернення з усіх каналів сходяться в одну стрічку, а заявки, нагадування й звіти — на одному екрані. Більше не треба перемикатися між телефоном, Direct і поштою.',
    hub: {
      sources: [
        { key: 'web', name: 'Форми сайту' },
        { key: 'instagram', name: 'Instagram' },
        { key: 'telegram', name: 'Telegram' },
        { key: 'messenger', name: 'Messenger' },
      ],
      center: 'ШІ відповідає · команда бачить',
      feedTitle: 'Одна стрічка звернень',
      feed: [
        { text: 'Заявка з форми «Запис на огляд»', ch: 'Сайт', tone: 'neutral' },
        { text: 'Скільки коштує чистка?', ch: 'Instagram', tone: 'ig' },
        { text: 'Перенесіть мене на п’ятницю', ch: 'Telegram', tone: 'tg' },
        { text: 'Чи працюєте в суботу?', ch: 'Messenger', tone: 'ms' },
      ],
      points: ['Канал видно в кожній розмові', 'Відповідь іде в той самий канал', 'Записи звіряються з Cliniccards', 'ШІ відповідає в усіх каналах — на будь-якому тарифі'],
    },
    inbox: {
      t: 'Усі месенджери — в одному списку',
      d: 'Telegram, Instagram і Messenger разом. Канал видно в кожній розмові, заявки — окремо, з кнопками дій.',
      rows: [
        { ini: 'ОК', name: 'Олена К.', text: 'Так, у четвер о 14:30 підходить', tag: 'Instagram', tone: 'ig' },
        { ini: 'АМ', name: 'Андрій М.', text: 'Можна перенести на п’ятницю?', tag: 'Telegram', tone: 'tg' },
        { ini: 'ІС', name: 'Ірина С.', text: 'Покличте, будь ласка, лікаря', tag: 'Людині', tone: 'warn' },
      ],
    },
    assistant: { t: 'Запитайте про клініку своїми словами', q: 'Покажи неявки за 3 місяці по лікарях', rows: [['Іваненко', 6], ['Петренко', 4], ['Сидоренко', 2]], note: 'Рахує система за правилами, не ШІ · тариф «Про»' },
    report: { t: '9 готових звітів', d: 'Кому час на повторний візит — і завдання адміністратору в один клік.', cols: ['Пацієнт', 'Без запису'], rows: [['Пацієнт 1', '48 дн.'], ['Пацієнт 2', '63 дн.'], ['Пацієнт 3', '91 дн.']], btn: 'Створити завдання · 3' },
    remind: { t: 'Нагадування самі', d: 'Перед відправкою запис звіряється з Cliniccards — зі старим часом нічого не піде.', rules: ['За 24 год до візиту', 'Після неявки', 'Час на гігієну'] },
  },
  ai: {
    eyebrow: '03 — ШІ-адміністратор',
    title1: 'Веде пацієнта по воронці продажу —',
    title2: 'від запитання до запису.',
    lead: 'Як досвідчений адміністратор: розуміє запит, знімає сумніви й доводить до запису. Хто одразу пише «запишіть на четвер» — переходить просто до вибору часу.',
    stages: [
      { t: 'Звернення', d: 'Розуміє, про що питають' },
      { t: 'Потреба', d: 'Уточнює послугу' },
      { t: 'Сумніви', d: 'Ціна, страх, вагання — затвердженими відповідями' },
      { t: 'Вибір часу', d: 'Вільні вікна з розкладу наживо' },
      { t: 'Запис', d: 'Заявка або запис у Cliniccards' },
    ],
    notes: ['Не анкета — підлаштовується під розмову', 'Хто питає лише ціну, отримує ціну без нав’язування', 'Нестандартне — одразу людині'],
    modes: [
      { k: 'Будь-який тариф · за бажанням', t: 'Чернетки для адміністратора', d: 'ШІ пише — людина перевіряє й надсилає одним натиском.' },
      { k: 'Будь-який тариф', t: 'Самостійні відповіді', d: 'Клініка вмикає після налаштування — і вимикає будь-коли.', accent: true },
      { k: 'Завжди', t: 'Людина поруч', d: 'Медичні питання, скарги й знижки — одразу адміністратору.' },
    ],
  },
  mid: { title1: 'Подивіться на живій клініці —', title2: 'за хвилину, без реєстрації.', cta: 'Відкрити демо →' },
  team: {
    eyebrow: '04 — Для всієї команди',
    title: 'Кожен бачить своє.',
    roles: [
      { t: 'Власник', q: 'Де заробити більше?', d: 'Хто не записався знову, оплати й борги, дайджест у Telegram.' },
      { t: 'Керуючий', q: 'Що чекає на команду?', d: 'Заявки й завдання на головній, сигнали в службовий чат.' },
      { t: 'Адміністратор', q: 'Як встигнути всім?', d: 'Усі месенджери разом, відповіді ШІ, заявки з кнопками.' },
      { t: 'Маркетолог', q: 'Звідки пацієнти?', d: 'Джерело кожного звернення, воронка до візиту, Excel.' },
    ],
    owner: {
      eyebrow: 'Для власника · тариф «Про»',
      title: 'Клініка під контролем — прямо в Telegram.',
      text: 'Щоранку — дайджест: прийоми, записи, неявки. Коли щось іде не так, LANKA пише сама: неявки, спад оплат, заявки без відповіді. Пороги ви задаєте самі.',
      chips: ['Неявки й скасування', 'Спад оплат', 'Заявки без відповіді', 'Незавершене лікування', 'Ще 4 сигнали'],
      chat: 'Команда клініки',
      chatSub: 'LANKA · службовий чат',
      digestT: 'Дайджест · вчора',
      digest: ['Прийоми: 18 · нових записів: 14', 'Неявки: 2 · заявок без відповіді: 0'],
      aiLine: 'ШІ підготував 9 заявок',
      signalT: 'Сигнал',
      signal: 'Скасовано або пропущено 27% візитів за 7 днів — поріг 25%.',
      open: 'Відкрити звіт →',
    },
  },
  launch: {
    eyebrow: '05 — Запуск',
    title1: 'Ви не налаштовуєте самі.',
    title2: 'Запускаємо разом.',
    lead: 'Разовий запуск — 4 990 грн. Оплачений період починається в день запуску, а не в день оплати.',
    steps: [
      { t: 'Підключаємо Cliniccards', d: 'Завантажуємо пацієнтів, візити, плани лікування й оплати, перевіряємо перші дані.' },
      { t: 'Підключаємо канали', d: 'Instagram, Telegram, Messenger і форми сайту — в одну стрічку.' },
      { t: 'Навчаємо ШІ', d: 'Послуги, ціни, відповіді на типові питання — ви затверджуєте кожну.' },
      { t: 'Вмикаємо й показуємо команді', d: 'Пояснюємо, де заявки, розмови й звіти. Далі — підтримка, коли потрібно.' },
    ],
  },
  pricing: {
    eyebrow: '06 — Тарифи',
    title: 'ШІ працює на кожному тарифі.',
    sub: 'ШІ-адміністратор сам відповідає в Instagram, Telegram і Messenger уже на «Старті». «Про» записує й переносить візити прямо в Cliniccards — адміністратору не треба нічого вносити.',
    monthly: 'Щомісяця',
    yearly: 'За рік',
    yearBadge: '−2 міс.',
    yearNote: 'Рік одним платежем — 12 місяців за ціною 10.',
    perMonth: 'грн/міс',
    perYear: 'грн/рік',
    orYear: 'або {sum} грн за рік —',
    save: 'економія {save} грн',
    approx: '≈ {sum} грн/міс',
    best: 'Найкращий вибір',
    plans: [
      {
        name: 'Старт', price: '1 990', year: '19 900', full: '23 880', save: '3 980', perMonthYear: '1 658',
        lead: 'ШІ відповідає сам, адміністратор підтверджує запис',
        aiT: 'ШІ-адміністратор', aiTag: 'відповідає сам',
        aiD: 'Відповідає пацієнтам 24/7, веде по воронці, пропонує вільний час і готує заявку — адміністратор вносить її в Cliniccards одним кліком.',
        aiMeta: 'Instagram, Telegram, Messenger · 500 відповідей ШІ/міс',
        alsoT: 'Також у тарифі',
        lines: ['ШІ-адміністратор сам відповідає в Instagram, Telegram і Messenger та готує заявку на запис', 'Нагадування й розсилки в Telegram', 'Заявки з форм сайту в одному журналі', '9 звітів, конструктор, воронка пацієнтів', 'Щотижневий дайджест керівнику'],
        cta: 'Обрати «Старт»',
      },
      {
        name: 'Про', price: '4 990', year: '49 900', full: '59 880', save: '9 980', perMonthYear: '4 158',
        lead: 'Запис без участі адміністратора',
        aiT: 'ШІ-адміністратор Pro', aiTag: 'записує сам',
        aiD: 'Усе зі «Старту», плюс сам створює й переносить візити в Cliniccards — пацієнт записаний ще до того, як адміністратор прийшов на роботу.',
        aiMeta: 'Автозапис і перенесення в Cliniccards',
        alsoT: 'Усе зі «Старту», а також',
        lines: ['ШІ сам записує й переносить візити в Cliniccards', '3 000 відповідей ШІ на місяць', 'ШІ-помічник керівника: питання — відповідь звітом', 'Щоденний дайджест і сигнали про відхилення'],
        cta: 'Обрати «Про»',
      },
    ],
    compareT: 'Старт і Про: чим відрізняються',
    compareCols: ['Можливість', 'Старт', 'Про'],
    compare: [
      { label: 'ШІ сам відповідає 24/7 в Instagram, Telegram і Messenger', start: '✓', pro: '✓' },
      { label: 'Веде по воронці, пропонує вільний час із розкладу', start: '✓', pro: '✓' },
      { label: 'Передає людині медичні питання, скарги й нестандартне', start: '✓', pro: '✓' },
      { label: 'Запис у Cliniccards', start: 'заявка → адміністратор вносить', pro: 'ШІ записує сам', strong: true },
      { label: 'Перенесення візиту', start: 'заявка адміністратору', pro: 'ШІ переносить сам', strong: true },
      { label: 'Відповідей ШІ на місяць', start: '500', pro: '3 000' },
      { label: 'ШІ-помічник керівника: питання — звіт', start: '—', pro: '✓' },
      { label: 'Сигнали про відхилення й щоденний дайджест', start: '—', pro: '✓' },
      { label: 'Користувачів', start: '5', pro: '30' },
    ],
    pack: 'Закінчилися відповіді — докупіть 500 за 390 грн, вони не згоряють.',
    launchT: 'Запуск — 4 990 грн',
    launchD: 'Разово, для «Старту» і «Про». Підключимо Cliniccards і канали, підготуємо знання для ШІ, навчимо команду. Оплачений період починається в день запуску.',
    network: { name: 'Мережа клінік', d: '— «Про» для кожного філіалу й порівняння філіалів. Від 7 990 грн/міс за 2 філіали, +2 990 грн за кожен наступний.', price: '7 990', cta: 'Обговорити →' },
  },
  trust: {
    eyebrow: '07 — Безпека',
    title: 'Контроль завжди за клінікою.',
    items: [
      { t: 'Затверджені відповіді', d: 'ШІ відповідає лише тим, що затвердила клініка.' },
      { t: 'Людина поруч', d: 'Медичні питання, скарги й нестандартне ШІ одразу передає адміністратору.' },
      { t: 'Дані пацієнтів', d: 'Імена й телефони з бази клініки до ШІ не передаються.' },
      { t: 'Захист', d: 'Двофакторний вхід, журнал дій, ролі й доступи.' },
    ],
  },
  faq: {
    eyebrow: '08 — Питання',
    title: 'Часті питання',
    more: 'Не знайшли відповідь?',
    moreLink: 'Залиште номер — передзвонимо.',
    items: [
      { q: 'Ми працюємо в Cliniccards. Що треба змінювати?', a: 'Нічого. Cliniccards лишається основною системою для пацієнтів, лікування й розкладу. LANKA працює поруч і щодня оновлює дані.' },
      { q: 'ШІ відповідає сам. А якщо він помилиться?', a: 'ШІ відповідає лише тим, що затвердила клініка: послуги, ціни, типові відповіді. Медичні питання, скарги, знижки й усе нестандартне він одразу передає адміністратору. Самостійні відповіді можна будь-коли перемкнути на чернетки.' },
      { q: 'Чим «Старт» відрізняється від «Про»?', a: 'На обох тарифах ШІ сам відповідає в Instagram, Telegram і Messenger та готує заявку. На «Старті» запис у Cliniccards вносить адміністратор, на «Про» ШІ записує й переносить візити сам. «Про» також додає помічника керівника, сигнали й щоденний дайджест.' },
      { q: 'Що буде, коли закінчаться відповіді ШІ?', a: 'ШІ стане на паузу до нового періоду, а листування продовжить команда. Можна докупити 500 відповідей за 390 грн — вони не згоряють. Боргу не виникає.' },
      { q: 'Наскільки свіжі дані?', a: 'Дані з Cliniccards оновлюються щодня о 03:00 і будь-коли кнопкою. Вільний час для запису перевіряється в розкладі в момент розмови.' },
      { q: 'Чи є безкоштовний період?', a: 'Замість нього — демо на вигаданій клініці. Відкривається за хвилину, без реєстрації.' },
      { q: 'Хто допоможе з налаштуванням?', a: 'Ми. Під час запуску підключимо дані й канали, підготуємо знання для ШІ та покажемо команді кабінет. Після запуску — підтримка поштою або дзвінком.' },
    ],
  },
  final: { title1: 'Наступне звернення', title2: 'не загубиться.', text: 'Демо відкривається за хвилину. Або залиште номер — розповімо, як пройде запуск у вашій клініці.', demo: 'Відкрити демо', formT: 'Передзвонимо й розкажемо про запуск' },
  contact: { title: 'Зв’яжемося з вами', text: 'Залиште номер — зателефонуємо, розповімо про запуск і відповімо на запитання.', phone: 'Телефон', name: 'Ім’я (необов’язково)', consent: 'Погоджуюся, щоб LANKA зв’язалася зі мною щодо підключення.', privacy: 'Політика конфіденційності', submit: 'Чекаю дзвінка', sending: 'Надсилаємо…', done: 'Дякуємо! Ми зв’яжемося з вами найближчим часом.', demoHint: 'Поки чекаєте — подивіться демо: копія вигаданої клініки, без реєстрації.', demo: 'Відкрити демо', error: 'Не вдалося надіслати. Перевірте номер або напишіть нам:', close: 'Закрити' },
  footer: { tagline: 'ШІ-адміністратор і робочий простір для стоматологічних клінік на Cliniccards.', product: 'Продукт', clients: 'Клієнтам', docs: 'Документи', features: 'Можливості', contact: 'Зв’язатися', copyright: '© LANKA, 2026', owner: { title: 'Власник сервісу LANKA' } },
};

const ru: LandingText = {
  nav: { product: 'Продукт', ai: 'ИИ-администратор', launch: 'Запуск', pricing: 'Тарифы', faq: 'Вопросы', login: 'Войти', demo: 'Демо за минуту', menu: 'Меню', terms: 'Условия', privacy: 'Конфиденциальность' },
  ui: { example: 'Пример', demoData: 'демо-данные' },
  hero: {
    badgeNew: 'Новое',
    badge: 'ИИ-администратор отвечает в Instagram',
    title1: 'Каждое обращение —',
    title2: 'в запись.',
    sub: 'ИИ отвечает пациентам в мессенджерах даже ночью, напоминает о визитах и показывает владельцу, где клиника теряет деньги. Рядом с Cliniccards — без переезда.',
    demo: 'Открыть демо — без регистрации',
    discuss: 'Обсудить запуск',
    appUrl: 'app.lankaclinic.app · Главная · демо-данные',
    stats: [
      { label: 'Новые записи', value: '64', delta: '↑ было 58', tone: 'ok' },
      { label: 'Приёмы', value: '86', delta: 'за неделю', tone: 'neutral' },
      { label: 'Неявки', value: '7', delta: '↑ было 5', tone: 'warn' },
    ],
    nowTitle: 'Нужно действие сейчас',
    nowUpdated: 'обновлено только что',
    now: [
      { text: 'ИИ подготовил заявку: гигиена, чт 14:30', tag: 'Instagram', tone: 'ai' },
      { text: '2 заявки ждут больше 4 часов', tag: 'Сигнал', tone: 'warn' },
      { text: '12 пациентов без следующей записи', tag: 'Отчёт', tone: 'ok' },
    ],
    chat: {
      handle: 'olena.k',
      status: 'Instagram · в сети',
      time: 'Сегодня 23:12',
      in1: 'Сколько стоит чистка? Немного боюсь',
      out1: 'Понимаю, так бывает у многих. Скажите об этом врачу в начале — он будет работать в вашем темпе. Профессиональная гигиена — 1 400 грн. Подобрать удобное время?',
      in2: 'Да, в четверг',
      out2: 'Свободно: чт 14:30 или 16:00',
      slots: ['14:30', '16:00'],
      ai: 'Отвечает ИИ-администратор LANKA',
      input: 'Сообщение…',
    },
    floatReq: { t: 'Новая заявка на запись', d: 'в 23:12 · пока администратор спал' },
    floatSignal: 'Сигнал: неявки 27% ↑',
  },
  strip: { label: 'Работает с тем, что у вас уже есть', items: ['Cliniccards', 'Instagram', 'Telegram', 'Messenger', 'Формы сайта', 'Excel и PDF'] },
  problem: {
    eyebrow: '01 — Где теряются пациенты',
    title1: 'Клиника теряет пациентов не в кресле, а',
    title2: 'между сообщениями.',
    lead: 'Три тихие ситуации, которые каждую неделю случаются почти в каждой клинике, — и что с ними делает LANKA.',
    rows: [
      { when: '23:12', loss: 'Сообщение в Instagram ночью', lossD: 'Ответ утром — пациент уже записался в другом месте.', fixT: 'С LANKA: ИИ отвечает сразу', fixD: 'Называет утверждённую цену, предлагает свободное время и готовит заявку к утру.', icon: 'ai' },
      { when: 'Пн', loss: 'Пациентка отменила визит', lossD: 'Никто не перезвонил, и она не вернулась.', fixT: 'С LANKA: она в списке на звонок', fixD: 'Отмена без новой записи видна сразу, задача администратору — в один клик.', icon: 'back' },
      { when: '30+ дн.', loss: 'Лечение начали, но не закончили', lossD: 'Следующей записи нет, и о плане никто не напомнил.', fixT: 'С LANKA: сигнал руководителю', fixD: 'Когда таких пациентов больше порога — сообщение в служебный Telegram.', icon: 'bell' },
    ],
  },
  product: {
    eyebrow: '02 — Продукт',
    title1: 'Сайт, Instagram, Telegram, Messenger —',
    title2: 'в одном месте.',
    lead: 'Обращения из всех каналов сходятся в одну ленту, а заявки, напоминания и отчёты — на одном экране. Больше не нужно переключаться между телефоном, Direct и почтой.',
    hub: {
      sources: [
        { key: 'web', name: 'Формы сайта' },
        { key: 'instagram', name: 'Instagram' },
        { key: 'telegram', name: 'Telegram' },
        { key: 'messenger', name: 'Messenger' },
      ],
      center: 'ИИ отвечает · команда видит',
      feedTitle: 'Одна лента обращений',
      feed: [
        { text: 'Заявка с формы «Запись на осмотр»', ch: 'Сайт', tone: 'neutral' },
        { text: 'Сколько стоит чистка?', ch: 'Instagram', tone: 'ig' },
        { text: 'Перенесите меня на пятницу', ch: 'Telegram', tone: 'tg' },
        { text: 'Работаете в субботу?', ch: 'Messenger', tone: 'ms' },
      ],
      points: ['Канал виден в каждом разговоре', 'Ответ уходит в тот же канал', 'Записи сверяются с Cliniccards', 'ИИ отвечает во всех каналах — на любом тарифе'],
    },
    inbox: {
      t: 'Все мессенджеры — в одном списке',
      d: 'Telegram, Instagram и Messenger вместе. Канал виден в каждом разговоре, заявки — отдельно, с кнопками действий.',
      rows: [
        { ini: 'ЕК', name: 'Елена К.', text: 'Да, в четверг в 14:30 подходит', tag: 'Instagram', tone: 'ig' },
        { ini: 'АМ', name: 'Андрей М.', text: 'Можно перенести на пятницу?', tag: 'Telegram', tone: 'tg' },
        { ini: 'ИС', name: 'Ирина С.', text: 'Позовите, пожалуйста, врача', tag: 'Человеку', tone: 'warn' },
      ],
    },
    assistant: { t: 'Спросите о клинике своими словами', q: 'Покажи неявки за 3 месяца по врачам', rows: [['Иваненко', 6], ['Петренко', 4], ['Сидоренко', 2]], note: 'Считает система по правилам, не ИИ · тариф «Про»' },
    report: { t: '9 готовых отчётов', d: 'Кому пора на повторный визит — и задача администратору в один клик.', cols: ['Пациент', 'Без записи'], rows: [['Пациент 1', '48 дн.'], ['Пациент 2', '63 дн.'], ['Пациент 3', '91 дн.']], btn: 'Создать задачи · 3' },
    remind: { t: 'Напоминания сами', d: 'Перед отправкой запись сверяется с Cliniccards — со старым временем ничего не уйдёт.', rules: ['За 24 ч до визита', 'После неявки', 'Пора на гигиену'] },
  },
  ai: {
    eyebrow: '03 — ИИ-администратор',
    title1: 'Ведёт пациента по воронке продаж —',
    title2: 'от вопроса до записи.',
    lead: 'Как опытный администратор: понимает запрос, снимает сомнения и доводит до записи. Кто сразу пишет «запишите на четверг» — переходит прямо к выбору времени.',
    stages: [
      { t: 'Обращение', d: 'Понимает, о чём спрашивают' },
      { t: 'Потребность', d: 'Уточняет услугу' },
      { t: 'Сомнения', d: 'Цена, страх, колебания — утверждёнными ответами' },
      { t: 'Выбор времени', d: 'Свободные окна из расписания вживую' },
      { t: 'Запись', d: 'Заявка или запись в Cliniccards' },
    ],
    notes: ['Не анкета — подстраивается под разговор', 'Кто спрашивает только цену, получает цену без навязывания', 'Нестандартное — сразу человеку'],
    modes: [
      { k: 'Любой тариф · по желанию', t: 'Черновики для администратора', d: 'ИИ пишет — человек проверяет и отправляет одним нажатием.' },
      { k: 'Любой тариф', t: 'Самостоятельные ответы', d: 'Клиника включает после настройки — и выключает в любой момент.', accent: true },
      { k: 'Всегда', t: 'Человек рядом', d: 'Медицинские вопросы, жалобы и скидки — сразу администратору.' },
    ],
  },
  mid: { title1: 'Посмотрите на живой клинике —', title2: 'за минуту, без регистрации.', cta: 'Открыть демо →' },
  team: {
    eyebrow: '04 — Для всей команды',
    title: 'Каждый видит своё.',
    roles: [
      { t: 'Владелец', q: 'Где заработать больше?', d: 'Кто не записался снова, оплаты и долги, дайджест в Telegram.' },
      { t: 'Управляющий', q: 'Что ждёт команду?', d: 'Заявки и задачи на главной, сигналы в служебный чат.' },
      { t: 'Администратор', q: 'Как успеть всем?', d: 'Все мессенджеры вместе, ответы ИИ, заявки с кнопками.' },
      { t: 'Маркетолог', q: 'Откуда пациенты?', d: 'Источник каждого обращения, воронка до визита, Excel.' },
    ],
    owner: {
      eyebrow: 'Для владельца · тариф «Про»',
      title: 'Клиника под контролем — прямо в Telegram.',
      text: 'Каждое утро — дайджест: приёмы, записи, неявки. Когда что-то идёт не так, LANKA пишет сама: неявки, спад оплат, заявки без ответа. Пороги вы задаёте сами.',
      chips: ['Неявки и отмены', 'Спад оплат', 'Заявки без ответа', 'Незавершённое лечение', 'Ещё 4 сигнала'],
      chat: 'Команда клиники',
      chatSub: 'LANKA · служебный чат',
      digestT: 'Дайджест · вчера',
      digest: ['Приёмы: 18 · новых записей: 14', 'Неявки: 2 · заявок без ответа: 0'],
      aiLine: 'ИИ подготовил 9 заявок',
      signalT: 'Сигнал',
      signal: 'Отменено или пропущено 27% визитов за 7 дней — порог 25%.',
      open: 'Открыть отчёт →',
    },
  },
  launch: {
    eyebrow: '05 — Запуск',
    title1: 'Вы не настраиваете сами.',
    title2: 'Запускаем вместе.',
    lead: 'Разовый запуск — 4 990 грн. Оплаченный период начинается в день запуска, а не в день оплаты.',
    steps: [
      { t: 'Подключаем Cliniccards', d: 'Загружаем пациентов, визиты, планы лечения и оплаты, проверяем первые данные.' },
      { t: 'Подключаем каналы', d: 'Instagram, Telegram, Messenger и формы сайта — в одну ленту.' },
      { t: 'Обучаем ИИ', d: 'Услуги, цены, ответы на типовые вопросы — вы утверждаете каждый.' },
      { t: 'Включаем и показываем команде', d: 'Объясняем, где заявки, разговоры и отчёты. Дальше — поддержка, когда нужно.' },
    ],
  },
  pricing: {
    eyebrow: '06 — Тарифы',
    title: 'ИИ работает на каждом тарифе.',
    sub: 'ИИ-администратор сам отвечает в Instagram, Telegram и Messenger уже на «Старте». «Про» записывает и переносит визиты прямо в Cliniccards — администратору ничего не нужно вносить.',
    monthly: 'Ежемесячно',
    yearly: 'За год',
    yearBadge: '−2 мес.',
    yearNote: 'Год одним платежом — 12 месяцев по цене 10.',
    perMonth: 'грн/мес',
    perYear: 'грн/год',
    orYear: 'или {sum} грн за год —',
    save: 'экономия {save} грн',
    approx: '≈ {sum} грн/мес',
    best: 'Лучший выбор',
    plans: [
      {
        name: 'Старт', price: '1 990', year: '19 900', full: '23 880', save: '3 980', perMonthYear: '1 658',
        lead: 'ИИ отвечает сам, администратор подтверждает запись',
        aiT: 'ИИ-администратор', aiTag: 'отвечает сам',
        aiD: 'Отвечает пациентам 24/7, ведёт по воронке, предлагает свободное время и готовит заявку — администратор вносит её в Cliniccards одним кликом.',
        aiMeta: 'Instagram, Telegram, Messenger · 500 ответов ИИ/мес',
        alsoT: 'Также в тарифе',
        lines: ['ИИ-администратор сам отвечает в Instagram, Telegram и Messenger и готовит заявку на запись', 'Напоминания и рассылки в Telegram', 'Заявки из форм сайта в одном журнале', '9 отчётов, конструктор, воронка пациентов', 'Еженедельный дайджест руководителю'],
        cta: 'Выбрать «Старт»',
      },
      {
        name: 'Про', price: '4 990', year: '49 900', full: '59 880', save: '9 980', perMonthYear: '4 158',
        lead: 'Запись без участия администратора',
        aiT: 'ИИ-администратор Pro', aiTag: 'записывает сам',
        aiD: 'Всё из «Старта», плюс сам создаёт и переносит визиты в Cliniccards — пациент записан ещё до того, как администратор пришёл на работу.',
        aiMeta: 'Автозапись и перенос в Cliniccards',
        alsoT: 'Всё из «Старта», а также',
        lines: ['ИИ сам записывает и переносит визиты в Cliniccards', '3 000 ответов ИИ в месяц', 'ИИ-помощник руководителя: вопрос — ответ отчётом', 'Ежедневный дайджест и сигналы об отклонениях'],
        cta: 'Выбрать «Про»',
      },
    ],
    compareT: 'Старт и Про: чем отличаются',
    compareCols: ['Возможность', 'Старт', 'Про'],
    compare: [
      { label: 'ИИ сам отвечает 24/7 в Instagram, Telegram и Messenger', start: '✓', pro: '✓' },
      { label: 'Ведёт по воронке, предлагает свободное время из расписания', start: '✓', pro: '✓' },
      { label: 'Передаёт человеку медицинские вопросы, жалобы и нестандартное', start: '✓', pro: '✓' },
      { label: 'Запись в Cliniccards', start: 'заявка → администратор вносит', pro: 'ИИ записывает сам', strong: true },
      { label: 'Перенос визита', start: 'заявка администратору', pro: 'ИИ переносит сам', strong: true },
      { label: 'Ответов ИИ в месяц', start: '500', pro: '3 000' },
      { label: 'ИИ-помощник руководителя: вопрос — отчёт', start: '—', pro: '✓' },
      { label: 'Сигналы об отклонениях и ежедневный дайджест', start: '—', pro: '✓' },
      { label: 'Пользователей', start: '5', pro: '30' },
    ],
    pack: 'Закончились ответы — докупите 500 за 390 грн, они не сгорают.',
    launchT: 'Запуск — 4 990 грн',
    launchD: 'Разово, для «Старта» и «Про». Подключим Cliniccards и каналы, подготовим знания для ИИ, обучим команду. Оплаченный период начинается в день запуска.',
    network: { name: 'Сеть клиник', d: '— «Про» для каждого филиала и сравнение филиалов. От 7 990 грн/мес за 2 филиала, +2 990 грн за каждый следующий.', price: '7 990', cta: 'Обсудить →' },
  },
  trust: {
    eyebrow: '07 — Безопасность',
    title: 'Контроль всегда за клиникой.',
    items: [
      { t: 'Утверждённые ответы', d: 'ИИ отвечает только тем, что утвердила клиника.' },
      { t: 'Человек рядом', d: 'Медицинские вопросы, жалобы и нестандартное ИИ сразу передаёт администратору.' },
      { t: 'Данные пациентов', d: 'Имена и телефоны из базы клиники в ИИ не передаются.' },
      { t: 'Защита', d: 'Двухфакторный вход, журнал действий, роли и доступы.' },
    ],
  },
  faq: {
    eyebrow: '08 — Вопросы',
    title: 'Частые вопросы',
    more: 'Не нашли ответ?',
    moreLink: 'Оставьте номер — перезвоним.',
    items: [
      { q: 'Мы работаем в Cliniccards. Что нужно менять?', a: 'Ничего. Cliniccards остаётся основной системой для пациентов, лечения и расписания. LANKA работает рядом и ежедневно обновляет данные.' },
      { q: 'ИИ отвечает сам. А если он ошибётся?', a: 'ИИ отвечает только тем, что утвердила клиника: услуги, цены, типовые ответы. Медицинские вопросы, жалобы, скидки и всё нестандартное он сразу передаёт администратору. Самостоятельные ответы можно в любой момент переключить на черновики.' },
      { q: 'Чем «Старт» отличается от «Про»?', a: 'На обоих тарифах ИИ сам отвечает в Instagram, Telegram и Messenger и готовит заявку. На «Старте» запись в Cliniccards вносит администратор, на «Про» ИИ записывает и переносит визиты сам. «Про» также добавляет помощника руководителя, сигналы и ежедневный дайджест.' },
      { q: 'Что будет, когда закончатся ответы ИИ?', a: 'ИИ встанет на паузу до нового периода, а переписку продолжит команда. Можно докупить 500 ответов за 390 грн — они не сгорают. Долга не возникает.' },
      { q: 'Насколько свежие данные?', a: 'Данные из Cliniccards обновляются ежедневно в 03:00 и в любой момент кнопкой. Свободное время для записи проверяется в расписании в момент разговора.' },
      { q: 'Есть ли бесплатный период?', a: 'Вместо него — демо на вымышленной клинике. Открывается за минуту, без регистрации.' },
      { q: 'Кто поможет с настройкой?', a: 'Мы. Во время запуска подключим данные и каналы, подготовим знания для ИИ и покажем команде кабинет. После запуска — поддержка по почте или звонком.' },
    ],
  },
  final: { title1: 'Следующее обращение', title2: 'не потеряется.', text: 'Демо открывается за минуту. Или оставьте номер — расскажем, как пройдёт запуск в вашей клинике.', demo: 'Открыть демо', formT: 'Перезвоним и расскажем о запуске' },
  contact: { title: 'Свяжемся с вами', text: 'Оставьте номер — позвоним, расскажем о запуске и ответим на вопросы.', phone: 'Телефон', name: 'Имя (необязательно)', consent: 'Согласен(на), чтобы LANKA связалась со мной по поводу подключения.', privacy: 'Политика конфиденциальности', submit: 'Жду звонка', sending: 'Отправляем…', done: 'Спасибо! Мы свяжемся с вами в ближайшее время.', demoHint: 'Пока ждёте — посмотрите демо: копия выдуманной клиники, без регистрации.', demo: 'Открыть демо', error: 'Не удалось отправить. Проверьте номер или напишите нам:', close: 'Закрыть' },
  footer: { tagline: 'ИИ-администратор и рабочее пространство для стоматологических клиник на Cliniccards.', product: 'Продукт', clients: 'Клиентам', docs: 'Документы', features: 'Возможности', contact: 'Связаться', copyright: '© LANKA, 2026', owner: { title: 'Владелец сервиса LANKA' } },
};

const en: LandingText = {
  nav: { product: 'Product', ai: 'AI administrator', launch: 'Launch', pricing: 'Pricing', faq: 'FAQ', login: 'Sign in', demo: 'Demo in a minute', menu: 'Menu', terms: 'Terms', privacy: 'Privacy' },
  ui: { example: 'Example', demoData: 'demo data' },
  hero: {
    badgeNew: 'New',
    badge: 'The AI administrator replies in Instagram',
    title1: 'Every enquiry —',
    title2: 'a booking.',
    sub: 'AI replies to patients in messengers even at night, reminds them of visits and shows the owner where the clinic loses money. Next to Cliniccards — no migration.',
    demo: 'Open the demo — no sign-up',
    discuss: 'Discuss the launch',
    appUrl: 'app.lankaclinic.app · Home · demo data',
    stats: [
      { label: 'New bookings', value: '64', delta: '↑ was 58', tone: 'ok' },
      { label: 'Visits', value: '86', delta: 'this week', tone: 'neutral' },
      { label: 'No-shows', value: '7', delta: '↑ was 5', tone: 'warn' },
    ],
    nowTitle: 'Needs action now',
    nowUpdated: 'updated just now',
    now: [
      { text: 'AI prepared a request: hygiene, Thu 14:30', tag: 'Instagram', tone: 'ai' },
      { text: '2 requests waiting over 4 hours', tag: 'Signal', tone: 'warn' },
      { text: '12 patients with no next booking', tag: 'Report', tone: 'ok' },
    ],
    chat: {
      handle: 'olena.k',
      status: 'Instagram · active now',
      time: 'Today 23:12',
      in1: 'How much is a cleaning? I’m a bit scared',
      out1: 'I understand, many people feel that way. Tell the dentist at the start — they will work at your pace. Professional hygiene is 1,400 UAH. Shall I find a convenient time?',
      in2: 'Yes, on Thursday',
      out2: 'Free slots: Thu 14:30 or 16:00',
      slots: ['14:30', '16:00'],
      ai: 'Answered by the LANKA AI administrator',
      input: 'Message…',
    },
    floatReq: { t: 'New booking request', d: 'at 23:12 · while the administrator slept' },
    floatSignal: 'Signal: no-shows 27% ↑',
  },
  strip: { label: 'Works with what you already have', items: ['Cliniccards', 'Instagram', 'Telegram', 'Messenger', 'Website forms', 'Excel and PDF'] },
  problem: {
    eyebrow: '01 — Where patients get lost',
    title1: 'A clinic loses patients not in the chair, but',
    title2: 'between messages.',
    lead: 'Three quiet situations that happen in almost every clinic every week — and what LANKA does about them.',
    rows: [
      { when: '23:12', loss: 'An Instagram message at night', lossD: 'A reply in the morning — the patient has already booked elsewhere.', fixT: 'With LANKA: AI replies at once', fixD: 'Gives the approved price, offers free time and prepares a request by morning.', icon: 'ai' },
      { when: 'Mon', loss: 'A patient cancelled her visit', lossD: 'Nobody called back, and she never returned.', fixT: 'With LANKA: she is on the call list', fixD: 'A cancellation with no new booking shows at once; a task for the administrator in one click.', icon: 'back' },
      { when: '30+ d', loss: 'Treatment started but not finished', lossD: 'No next booking, and nobody reminded them of the plan.', fixT: 'With LANKA: a signal to the manager', fixD: 'When there are more such patients than the threshold — a message to the staff Telegram.', icon: 'bell' },
    ],
  },
  product: {
    eyebrow: '02 — Product',
    title1: 'Website, Instagram, Telegram, Messenger —',
    title2: 'in one place.',
    lead: 'Enquiries from every channel meet in one feed; requests, reminders and reports on one screen. No more switching between the phone, Direct and email.',
    hub: {
      sources: [
        { key: 'web', name: 'Website forms' },
        { key: 'instagram', name: 'Instagram' },
        { key: 'telegram', name: 'Telegram' },
        { key: 'messenger', name: 'Messenger' },
      ],
      center: 'AI replies · the team sees',
      feedTitle: 'One enquiry feed',
      feed: [
        { text: 'Request from the “Check-up” form', ch: 'Website', tone: 'neutral' },
        { text: 'How much is a cleaning?', ch: 'Instagram', tone: 'ig' },
        { text: 'Move me to Friday, please', ch: 'Telegram', tone: 'tg' },
        { text: 'Are you open on Saturday?', ch: 'Messenger', tone: 'ms' },
      ],
      points: ['The channel shows in every conversation', 'The reply goes to the same channel', 'Bookings are checked against Cliniccards', 'AI replies in every channel — on any plan'],
    },
    inbox: {
      t: 'Every messenger in one list',
      d: 'Telegram, Instagram and Messenger together. The channel shows in every conversation; requests are separate, with action buttons.',
      rows: [
        { ini: 'OK', name: 'Olena K.', text: 'Yes, Thursday 14:30 works', tag: 'Instagram', tone: 'ig' },
        { ini: 'AM', name: 'Andrii M.', text: 'Can I move it to Friday?', tag: 'Telegram', tone: 'tg' },
        { ini: 'IS', name: 'Iryna S.', text: 'Please call the dentist', tag: 'To a person', tone: 'warn' },
      ],
    },
    assistant: { t: 'Ask about the clinic in your own words', q: 'Show no-shows for 3 months by dentist', rows: [['Ivanenko', 6], ['Petrenko', 4], ['Sydorenko', 2]], note: 'The system counts by rules, not AI · Pro plan' },
    report: { t: '9 ready reports', d: 'Who is due a repeat visit — and a task for the administrator in one click.', cols: ['Patient', 'No booking'], rows: [['Patient 1', '48 d'], ['Patient 2', '63 d'], ['Patient 3', '91 d']], btn: 'Create tasks · 3' },
    remind: { t: 'Reminders on their own', d: 'Before sending, the booking is checked against Cliniccards — nothing goes out with an old time.', rules: ['24 h before the visit', 'After a no-show', 'Time for hygiene'] },
  },
  ai: {
    eyebrow: '03 — AI administrator',
    title1: 'Leads the patient through the sales funnel —',
    title2: 'from question to booking.',
    lead: 'Like an experienced administrator: understands the request, removes doubts and brings it to a booking. Someone who writes “book me for Thursday” goes straight to picking a time.',
    stages: [
      { t: 'Enquiry', d: 'Understands the question' },
      { t: 'Need', d: 'Clarifies the service' },
      { t: 'Doubts', d: 'Price, fear, hesitation — with approved answers' },
      { t: 'Time', d: 'Free slots from the live schedule' },
      { t: 'Booking', d: 'A request or a booking in Cliniccards' },
    ],
    notes: ['Not a questionnaire — adapts to the conversation', 'Someone asking only the price gets the price, no pressure', 'Anything unusual goes to a person'],
    modes: [
      { k: 'Any plan · optional', t: 'Drafts for the administrator', d: 'AI writes — a person checks and sends in one tap.' },
      { k: 'Any plan', t: 'Replies on its own', d: 'The clinic switches it on after setup — and off at any time.', accent: true },
      { k: 'Always', t: 'A person nearby', d: 'Medical questions, complaints and discounts go straight to the administrator.' },
    ],
  },
  mid: { title1: 'See it on a live clinic —', title2: 'in a minute, no sign-up.', cta: 'Open the demo →' },
  team: {
    eyebrow: '04 — For the whole team',
    title: 'Everyone sees their part.',
    roles: [
      { t: 'Owner', q: 'Where to earn more?', d: 'Who did not rebook, payments and debts, a digest in Telegram.' },
      { t: 'Manager', q: 'What is waiting for the team?', d: 'Requests and tasks on the home page, signals to the staff chat.' },
      { t: 'Administrator', q: 'How to answer everyone?', d: 'All messengers together, AI replies, requests with buttons.' },
      { t: 'Marketer', q: 'Where do patients come from?', d: 'The source of every enquiry, the funnel to a visit, Excel.' },
    ],
    owner: {
      eyebrow: 'For the owner · Pro plan',
      title: 'The clinic under control — right in Telegram.',
      text: 'Every morning, a digest: visits, bookings, no-shows. When something goes wrong, LANKA writes on its own: no-shows, falling payments, unanswered requests. You set the thresholds.',
      chips: ['No-shows and cancellations', 'Falling payments', 'Unanswered requests', 'Unfinished treatment', '4 more signals'],
      chat: 'Clinic team',
      chatSub: 'LANKA · staff chat',
      digestT: 'Digest · yesterday',
      digest: ['Visits: 18 · new bookings: 14', 'No-shows: 2 · unanswered requests: 0'],
      aiLine: 'AI prepared 9 requests',
      signalT: 'Signal',
      signal: '27% of visits cancelled or missed in 7 days — threshold 25%.',
      open: 'Open the report →',
    },
  },
  launch: {
    eyebrow: '05 — Launch',
    title1: 'You don’t set it up alone.',
    title2: 'We launch together.',
    lead: 'One-time launch — 4,990 UAH. The paid period starts on the launch day, not the payment day.',
    steps: [
      { t: 'We connect Cliniccards', d: 'We load patients, visits, treatment plans and payments and check the first data.' },
      { t: 'We connect the channels', d: 'Instagram, Telegram, Messenger and website forms — into one feed.' },
      { t: 'We teach the AI', d: 'Services, prices, answers to common questions — you approve each one.' },
      { t: 'We switch it on and show the team', d: 'Where requests, conversations and reports are. Then support whenever you need it.' },
    ],
  },
  pricing: {
    eyebrow: '06 — Pricing',
    title: 'AI works on every plan.',
    sub: 'The AI administrator replies on its own in Instagram, Telegram and Messenger already on Start. Pro books and reschedules visits right in Cliniccards — the administrator has nothing to enter.',
    monthly: 'Monthly',
    yearly: 'Yearly',
    yearBadge: '−2 mo',
    yearNote: 'A year in one payment — 12 months for the price of 10.',
    perMonth: 'UAH/mo',
    perYear: 'UAH/yr',
    orYear: 'or {sum} UAH a year —',
    save: 'save {save} UAH',
    approx: '≈ {sum} UAH/mo',
    best: 'Best choice',
    plans: [
      {
        name: 'Start', price: '1,990', year: '19,900', full: '23,880', save: '3,980', perMonthYear: '1,658',
        lead: 'AI replies on its own, the administrator confirms the booking',
        aiT: 'AI administrator', aiTag: 'replies on its own',
        aiD: 'Replies to patients 24/7, leads through the funnel, offers free time and prepares a request — the administrator enters it in Cliniccards in one click.',
        aiMeta: 'Instagram, Telegram, Messenger · 500 AI replies/mo',
        alsoT: 'Also included',
        lines: ['The AI administrator replies on its own in Instagram, Telegram and Messenger and prepares a booking request', 'Reminders and campaigns in Telegram', 'Website form requests in one log', '9 reports, a report builder, the patient funnel', 'A weekly digest for the manager'],
        cta: 'Choose Start',
      },
      {
        name: 'Pro', price: '4,990', year: '49,900', full: '59,880', save: '9,980', perMonthYear: '4,158',
        lead: 'Booking without the administrator',
        aiT: 'AI administrator Pro', aiTag: 'books on its own',
        aiD: 'Everything in Start, plus it creates and reschedules visits in Cliniccards itself — the patient is booked before the administrator gets to work.',
        aiMeta: 'Auto-booking and rescheduling in Cliniccards',
        alsoT: 'Everything in Start, plus',
        lines: ['AI books and reschedules visits in Cliniccards itself', '3,000 AI replies a month', 'The manager’s AI assistant: a question — a report', 'A daily digest and deviation signals'],
        cta: 'Choose Pro',
      },
    ],
    compareT: 'Start and Pro: the difference',
    compareCols: ['Feature', 'Start', 'Pro'],
    compare: [
      { label: 'AI replies on its own 24/7 in Instagram, Telegram and Messenger', start: '✓', pro: '✓' },
      { label: 'Leads through the funnel, offers free time from the schedule', start: '✓', pro: '✓' },
      { label: 'Hands medical questions, complaints and anything unusual to a person', start: '✓', pro: '✓' },
      { label: 'Booking in Cliniccards', start: 'request → the administrator enters it', pro: 'AI books itself', strong: true },
      { label: 'Rescheduling a visit', start: 'a request to the administrator', pro: 'AI reschedules itself', strong: true },
      { label: 'AI replies a month', start: '500', pro: '3,000' },
      { label: 'The manager’s AI assistant: a question — a report', start: '—', pro: '✓' },
      { label: 'Deviation signals and a daily digest', start: '—', pro: '✓' },
      { label: 'Users', start: '5', pro: '30' },
    ],
    pack: 'Ran out of replies? Buy 500 more for 390 UAH; they do not expire.',
    launchT: 'Launch — 4,990 UAH',
    launchD: 'One-time, for Start and Pro. We connect Cliniccards and the channels, prepare the AI’s knowledge and train the team. The paid period starts on the launch day.',
    network: { name: 'Clinic network', d: '— Pro for every branch and a branch comparison. From 7,990 UAH/mo for 2 branches, +2,990 UAH for each further one.', price: '7,990', cta: 'Discuss →' },
  },
  trust: {
    eyebrow: '07 — Security',
    title: 'The clinic is always in control.',
    items: [
      { t: 'Approved answers', d: 'AI answers only with what the clinic approved.' },
      { t: 'A person nearby', d: 'Medical questions, complaints and anything unusual go straight to the administrator.' },
      { t: 'Patient data', d: 'Names and phones from the clinic’s database are never sent to the AI.' },
      { t: 'Protection', d: 'Two-factor sign-in, an action log, roles and access rights.' },
    ],
  },
  faq: {
    eyebrow: '08 — Questions',
    title: 'Frequent questions',
    more: 'Didn’t find the answer?',
    moreLink: 'Leave your number — we’ll call back.',
    items: [
      { q: 'We work in Cliniccards. What do we need to change?', a: 'Nothing. Cliniccards stays the main system for patients, treatment and the schedule. LANKA works next to it and updates the data daily.' },
      { q: 'AI replies on its own. What if it makes a mistake?', a: 'AI answers only with what the clinic approved: services, prices, common answers. Medical questions, complaints, discounts and anything unusual go straight to the administrator. Replies on its own can be switched back to drafts at any time.' },
      { q: 'How does Start differ from Pro?', a: 'On both plans AI replies on its own in Instagram, Telegram and Messenger and prepares a request. On Start the administrator enters the booking in Cliniccards; on Pro AI books and reschedules visits itself. Pro also adds the manager’s assistant, signals and a daily digest.' },
      { q: 'What happens when the AI replies run out?', a: 'AI pauses until the next period and the team carries on with the conversations. You can buy 500 more replies for 390 UAH; they do not expire. No debt arises.' },
      { q: 'How fresh is the data?', a: 'Data from Cliniccards updates daily at 03:00 and any time with a button. Free time for a booking is checked in the schedule during the conversation.' },
      { q: 'Is there a free trial?', a: 'Instead, a demo on a made-up clinic. It opens in a minute, no sign-up.' },
      { q: 'Who helps with the setup?', a: 'We do. During the launch we connect the data and channels, prepare the AI’s knowledge and show the team the workspace. After the launch — support by email or phone.' },
    ],
  },
  final: { title1: 'The next enquiry', title2: 'won’t get lost.', text: 'The demo opens in a minute. Or leave your number — we’ll tell you how the launch goes in your clinic.', demo: 'Open the demo', formT: 'We’ll call back and tell you about the launch' },
  contact: { title: 'We’ll get in touch', text: 'Leave your number — we’ll call, tell you about the launch and answer your questions.', phone: 'Phone', name: 'Name (optional)', consent: 'I agree that LANKA may contact me about the connection.', privacy: 'Privacy policy', submit: 'Call me back', sending: 'Sending…', done: 'Thank you! We’ll be in touch soon.', demoHint: 'While you wait, try the demo: a copy of a made-up clinic, no sign-up.', demo: 'Open the demo', error: 'Could not send. Check the number or write to us:', close: 'Close' },
  footer: { tagline: 'An AI administrator and workspace for dental clinics on Cliniccards.', product: 'Product', clients: 'Clients', docs: 'Documents', features: 'Features', contact: 'Contact us', copyright: '© LANKA, 2026', owner: { title: 'Owner of the LANKA service' } },
};

export const LANDING: Record<Locale, LandingText> = { uk, ru, en };
