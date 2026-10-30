import type { Locale } from './i18n';

// Text of the public landing page. Prices and limits repeat apps/api/src/service/plans.ts: change both together.
// Only integrations that really work are marked live: flip the flag after a live check, not before.
export interface LandingText {
  nav: { features: string; demo: string; integrations: string; pricing: string; faq: string; login: string; terms: string; privacy: string };
  hero: { title: string; sub: string; demo: string; connect: string; note: string };
  result: { title: string; items: { t: string; d: string }[] };
  features: { id: string; title: string; text: string; points: string[] }[];
  demo: { title: string; text: string; steps: string[]; cta: string };
  integrations: { title: string; sub: string; live: string; soon: string; list: { name: string; what: string; live: boolean }[] };
  pricing: {
    title: string;
    sub: string;
    setup: string;
    setupText: string;
    perMonth: string;
    plans: { name: string; price: string; lines: string[]; pro?: boolean }[];
    ai: { title: string; text: string; pack: string };
    noTrial: string;
    cta: string;
  };
  steps: { title: string; items: { t: string; d: string }[] };
  security: { title: string; items: string[] };
  faq: { title: string; items: { q: string; a: string }[] };
  final: { title: string; text: string };
  mock: { report: string; chatIn: string; chatOut: string; slots: string[]; funnel: string[]; rules: string[]; rows: string[][] };
  footer: string;
}

const uk: LandingText = {
  nav: { features: 'Можливості', demo: 'Демо', integrations: 'Інтеграції', pricing: 'Тарифи', faq: 'Питання', login: 'Увійти', terms: 'Умови', privacy: 'Конфіденційність' },
  hero: {
    title: 'Клініка на Cliniccards без ручної рутини',
    sub: 'LANKA бере дані з Cliniccards і сама готує звіти, нагадує пацієнтам, відповідає на повідомлення та показує, де клініка втрачає людей. Адміністратор лише підтверджує.',
    demo: 'Подивитись демо',
    connect: 'Підключити клініку',
    note: 'Демо працює на вигаданих даних і не потребує реєстрації.',
  },
  result: {
    title: 'Що змінюється для клініки',
    items: [
      { t: 'Звіти без таблиць', d: 'Хто не записаний, хто не прийшов, борги, вільні вікна: з Excel та PDF, з правилом розрахунку й датою даних.' },
      { t: 'ШІ-адміністратор', d: 'Відповідає в месенджері, пропонує час за реальним розкладом і передає людині те, що не має вирішувати сам.' },
      { t: 'Менше втрачених пацієнтів', d: 'Нагадування, повернення «давно не були», оцінка візиту: усе за сценаріями, які ви контролюєте.' },
      { t: 'Видно весь шлях', d: 'Від першого звернення до візиту й оплати: де зупиняються люди і скільки ви на цьому втрачаєте.' },
    ],
  },
  features: [
    { id: 'reports', title: 'Звіти й конструктор', text: 'Дев’ять готових звітів і конструктор власних. Розрахунки робить код, не ШІ, тому цифрам можна вірити.', points: ['Excel, PDF і CSV одним кліком', 'Кожен звіт показує правило й дату оновлення', 'Запитайте помічника словами: він збере звіт, а порахує система'] },
    { id: 'ai', title: 'ШІ відповідає пацієнтам', text: 'Пацієнт пише в месенджер, ШІ відповідає за секунди, а складні та чутливі питання одразу йдуть людині.', points: ['Час для запису пропонується кнопками із вільних вікон', 'Питання про здоров’я й скарги ШІ не вирішує сам, а ціни називає лише із затвердженого вами переліку', 'Імена й телефони пацієнтів до моделі не передаються'] },
    { id: 'booking', title: 'Запис без дзвінків', text: 'ШІ збирає побажання пацієнта, підбирає час за розкладом і готує заявку, а адміністратор підтверджує її в кілька секунд.', points: ['Заявки зібрані в одному списку', 'Вибір часу пацієнтом одразу видно адміністратору', 'Cliniccards залишається основною системою'] },
    { id: 'auto', title: 'Автоматизації', text: 'Нагадування про візит, повернення, день народження, подяка й оцінка: готові сценарії з підтвердженням перед відправкою.', points: ['Не більше однієї реклами на пацієнта за 14 днів', 'Повідомлення лише у зручні години', 'Журнал: що, кому й чому не відправлено'] },
    { id: 'funnel', title: 'Воронка пацієнта', text: 'Бачите шлях від звернення до лікування й повернення, джерела пацієнтів і те, де вони відпадають, зі списками людей.', points: ['Когорти та джерела', 'Результат розсилок: хто записався після повідомлення', 'Тижневі зведення керівнику в Telegram'] },
  ],
  demo: {
    title: 'Спробуйте самі, без реєстрації',
    text: 'Натисніть кнопку: вам відкриється власна копія вигаданої клініки з пацієнтами, записами, звітами та листуванням. Нічого справжнього в ній немає, повідомлення лише імітуються.',
    steps: ['Відкрийте звіт і завантажте його в Excel', 'У «Листуванні» попросіть ШІ підготувати відповідь', 'Подивіться воронку й оцінки пацієнтів'],
    cta: 'Відкрити демо',
  },
  integrations: {
    title: 'Інтеграції',
    sub: 'У списку «Працює» лише те, що перевірено на справжньому підключенні. Решту підключаємо зараз і додаємо сюди по мірі перевірки.',
    live: 'Працює',
    soon: 'Підключаємо',
    list: [
      { name: 'Cliniccards', what: 'Читання пацієнтів, візитів, планів лікування й оплат', live: true },
      { name: 'Email', what: 'Звіти та сповіщення на пошту', live: true },
      { name: 'Telegram', what: 'Бот клініки: нагадування, відповіді, заявки', live: false },
      { name: 'Instagram', what: 'Відповіді на повідомлення в Direct', live: false },
      { name: 'Facebook Messenger', what: 'Відповіді на повідомлення сторінки', live: false },
      { name: 'WhatsApp', what: 'Офіційне підключення Meta', live: false },
      { name: 'Viber', what: 'Двосторонній чат Viber Business', live: false },
      { name: 'Чат на сайті клініки', what: 'Віджет, у якому відповідає той самий ШІ', live: false },
      { name: 'Binotel, Ringostat', what: 'Історія дзвінків і пропущені звернення', live: false },
      { name: 'Google Таблиці', what: 'Оновлення вибраних таблиць', live: false },
      { name: 'Meta Lead Ads', what: 'Заявки з рекламних форм', live: false },
      { name: 'LiqPay', what: 'Оплата LANKA й додаткових відповідей ШІ', live: false },
    ],
  },
  pricing: {
    title: 'Тарифи',
    sub: 'Одна ціна на клініку, без оплати за кожного пацієнта.',
    setup: 'Підключення $99 одноразово',
    setupText: 'Ми підключаємо Cliniccards, налаштовуємо клініку й допомагаємо з каналами. Платиться разом із першим місяцем.',
    perMonth: 'грн/міс',
    plans: [
      { name: 'Старт', price: '1 990', lines: ['До 10 співробітників', '2 000 автоматичних повідомлень на місяць', '500 відповідей ШІ на місяць', 'Звіти, конструктор, помічник керівника', 'Telegram та автоматизації з підтвердженням'] },
      { name: 'Про', price: '3 990', pro: true, lines: ['До 30 співробітників', '10 000 автоматичних повідомлень на місяць', '3 000 відповідей ШІ на місяць', 'Усе зі «Старту»', 'ШІ відповідає пацієнтам сам', 'Кілька каналів зв’язку', 'Розширена аналітика й щоденні зведення'] },
    ],
    ai: {
      title: 'Відповіді ШІ простими словами',
      text: 'Відповідь — це відповідь пацієнту, підготовлена чернетка або запит до помічника керівника. У кабінеті видно «Використано 180 з 500», залишок і кнопку докупити. Коли відповіді закінчуються, ШІ передає розмову співробітнику, боргу немає. Куплені відповіді переносяться на наступні місяці.',
      pack: 'Додатковий пакет: 500 відповідей за 390 грн',
    },
    noTrial: 'Безкоштовного періоду немає: замість нього — демо на вигаданих даних. Доступ до даних вашої клініки відкривається після оплати.',
    cta: 'Підключити клініку',
  },
  steps: {
    title: 'Як підключитися',
    items: [
      { t: 'Дивитесь демо', d: 'Без реєстрації, на вигаданих даних.' },
      { t: 'Реєструєтесь і оплачуєте', d: 'Підключення й перший місяць тарифу.' },
      { t: 'Даєте ключ Cliniccards', d: 'Дані завантажуються самі, починаючи з перших хвилин.' },
      { t: 'Підключаємо канали', d: 'Месенджери налаштовуємо разом, ви лише підтверджуєте доступи.' },
    ],
  },
  security: {
    title: 'Безпека та дані пацієнтів',
    items: [
      'Cliniccards лише читаємо: ми нічого там не змінюємо без вашого рішення.',
      'Ключі та токени зберігаються зашифрованими.',
      'Дані кожної клініки повністю відокремлені від інших.',
      'Ролі: лікар не бачить грошей, доступ співробітника закривається одразу.',
      'Двофакторний вхід і журнал дій, включно з переглядом карток і вивантаженнями.',
      'Імена й телефони пацієнтів не передаються ШІ. Небезпечні теми ШІ передає людині.',
      'Експорт своїх даних доступний на будь-якому тарифі.',
    ],
  },
  faq: {
    title: 'Часті питання',
    items: [
      { q: 'Чи потрібно відмовлятися від Cliniccards?', a: 'Ні. Cliniccards залишається основною системою, а LANKA читає з неї дані й додає звіти, автоматизацію та спілкування.' },
      { q: 'Чи може ШІ помилитися?', a: 'Розрахунки в звітах робить код. У розмовах ШІ має жорсткі межі: не обговорює здоров’я, знижки та скарги, ціни називає лише із затвердженого клінікою переліку, а час пропонує лише з реальних вільних вікон. Усе, що викликає сумнів, іде людині.' },
      { q: 'Чи будуть пацієнти отримувати спам?', a: 'Ні. Реклама потребує згоди, не частіше одного разу на 14 днів, лише у зручні години, і є «Зупинити». Повідомлення за замовчуванням підтверджує співробітник.' },
      { q: 'Як пацієнти потрапляють до бота?', a: 'Месенджер дозволяє писати лише тим, хто сам натиснув «Старт». Тому ми даємо QR-код і персональні посилання для рецепції, а охоплення зростає поступово.' },
      { q: 'Що буде, якщо закінчаться відповіді ШІ?', a: 'ШІ передасть розмову співробітнику. Можна докупити пакет. Боргу не накопичується.' },
      { q: 'Де зберігаються дані?', a: 'У захищеній базі даних сервісу, окремо для кожної клініки. Умови обробки даних приймаються під час реєстрації.' },
    ],
  },
  final: { title: 'Подивіться, як це працює в клініці', text: 'Відкрийте демо за хвилину або підключіть свою клініку.' },
  mock: {
    report: 'Пацієнти без наступного запису',
    chatIn: 'Добрий день! Хочу на чистку.',
    chatOut: 'Звісно! Оберіть зручний час кнопкою нижче, а адміністратор підтвердить запис.',
    slots: ['Вт 03.11, 10:00', 'Вт 03.11, 14:30', 'Ср 04.11, 09:00'],
    funnel: ['Звернення', 'Записались', 'Прийшли', 'Лікування'],
    rules: ['Нагадування про візит', 'Повернення «давно не були»', 'Оцінка візиту'],
    rows: [['Коваленко О.', '8 міс.', 'Чистка'], ['Шевченко А.', '11 міс.', 'Огляд'], ['Бондаренко М.', '14 міс.', 'Лікування']],
  },
  footer: '© LANKA. Сервіс для стоматологічних клінік на Cliniccards.',
};

const ru: LandingText = {
  nav: { features: 'Возможности', demo: 'Демо', integrations: 'Интеграции', pricing: 'Тарифы', faq: 'Вопросы', login: 'Войти', terms: 'Условия', privacy: 'Конфиденциальность' },
  hero: {
    title: 'Клиника на Cliniccards без ручной рутины',
    sub: 'LANKA берёт данные из Cliniccards и сама готовит отчёты, напоминает пациентам, отвечает на сообщения и показывает, где клиника теряет людей. Администратору остаётся подтвердить.',
    demo: 'Посмотреть демо',
    connect: 'Подключить клинику',
    note: 'Демо работает на выдуманных данных и не требует регистрации.',
  },
  result: {
    title: 'Что меняется для клиники',
    items: [
      { t: 'Отчёты без таблиц', d: 'Кто не записан, кто не пришёл, долги, свободные окна: с Excel и PDF, с правилом расчёта и датой данных.' },
      { t: 'ИИ-администратор', d: 'Отвечает в мессенджере, предлагает время по реальному расписанию и передаёт человеку то, что не должен решать сам.' },
      { t: 'Меньше потерянных пациентов', d: 'Напоминания, возврат «давно не были», оценка визита: всё по сценариям, которые вы контролируете.' },
      { t: 'Виден весь путь', d: 'От первого обращения до визита и оплаты: где останавливаются люди и сколько вы на этом теряете.' },
    ],
  },
  features: [
    { id: 'reports', title: 'Отчёты и конструктор', text: 'Девять готовых отчётов и конструктор собственных. Расчёты делает код, а не ИИ, поэтому цифрам можно верить.', points: ['Excel, PDF и CSV одним кликом', 'Каждый отчёт показывает правило и дату обновления', 'Спросите помощника словами: он соберёт отчёт, а посчитает система'] },
    { id: 'ai', title: 'ИИ отвечает пациентам', text: 'Пациент пишет в мессенджер, ИИ отвечает за секунды, а сложные и чувствительные вопросы сразу уходят человеку.', points: ['Время для записи предлагается кнопками из свободных окон', 'Вопросы о здоровье и жалобах ИИ не решает сам, а цены называет только из утверждённого вами перечня', 'Имена и телефоны пациентов в модель не передаются'] },
    { id: 'booking', title: 'Запись без звонков', text: 'ИИ собирает пожелания пациента, подбирает время по расписанию и готовит заявку, а администратор подтверждает её за несколько секунд.', points: ['Заявки собраны в одном списке', 'Выбор времени пациентом сразу виден администратору', 'Cliniccards остаётся основной системой'] },
    { id: 'auto', title: 'Автоматизации', text: 'Напоминание о визите, возврат, день рождения, благодарность и оценка: готовые сценарии с подтверждением перед отправкой.', points: ['Не больше одной рекламы на пациента за 14 дней', 'Сообщения только в удобные часы', 'Журнал: что, кому и почему не отправлено'] },
    { id: 'funnel', title: 'Воронка пациента', text: 'Видите путь от обращения до лечения и возврата, источники пациентов и то, где они отваливаются, со списками людей.', points: ['Когорты и источники', 'Результат рассылок: кто записался после сообщения', 'Недельные сводки руководителю в Telegram'] },
  ],
  demo: {
    title: 'Попробуйте сами, без регистрации',
    text: 'Нажмите кнопку: вам откроется собственная копия выдуманной клиники с пациентами, записями, отчётами и перепиской. Ничего настоящего в ней нет, сообщения только имитируются.',
    steps: ['Откройте отчёт и выгрузите его в Excel', 'В «Переписке» попросите ИИ подготовить ответ', 'Посмотрите воронку и оценки пациентов'],
    cta: 'Открыть демо',
  },
  integrations: {
    title: 'Интеграции',
    sub: 'В списке «Работает» только то, что проверено на настоящем подключении. Остальное подключаем сейчас и добавим сюда по мере проверки.',
    live: 'Работает',
    soon: 'Подключаем',
    list: [
      { name: 'Cliniccards', what: 'Чтение пациентов, визитов, планов лечения и оплат', live: true },
      { name: 'Email', what: 'Отчёты и уведомления на почту', live: true },
      { name: 'Telegram', what: 'Бот клиники: напоминания, ответы, заявки', live: false },
      { name: 'Instagram', what: 'Ответы на сообщения в Direct', live: false },
      { name: 'Facebook Messenger', what: 'Ответы на сообщения страницы', live: false },
      { name: 'WhatsApp', what: 'Официальное подключение Meta', live: false },
      { name: 'Viber', what: 'Двусторонний чат Viber Business', live: false },
      { name: 'Чат на сайте клиники', what: 'Виджет, в котором отвечает тот же ИИ', live: false },
      { name: 'Binotel, Ringostat', what: 'История звонков и пропущенные обращения', live: false },
      { name: 'Google Таблицы', what: 'Обновление выбранных таблиц', live: false },
      { name: 'Meta Lead Ads', what: 'Заявки из рекламных форм', live: false },
      { name: 'LiqPay', what: 'Оплата LANKA и дополнительных ответов ИИ', live: false },
    ],
  },
  pricing: {
    title: 'Тарифы',
    sub: 'Одна цена на клинику, без оплаты за каждого пациента.',
    setup: 'Подключение $99 единовременно',
    setupText: 'Мы подключаем Cliniccards, настраиваем клинику и помогаем с каналами. Платится вместе с первым месяцем.',
    perMonth: 'грн/мес',
    plans: [
      { name: 'Старт', price: '1 990', lines: ['До 10 сотрудников', '2 000 автоматических сообщений в месяц', '500 ответов ИИ в месяц', 'Отчёты, конструктор, помощник руководителя', 'Telegram и автоматизации с подтверждением'] },
      { name: 'Про', price: '3 990', pro: true, lines: ['До 30 сотрудников', '10 000 автоматических сообщений в месяц', '3 000 ответов ИИ в месяц', 'Всё из «Старта»', 'ИИ отвечает пациентам сам', 'Несколько каналов связи', 'Расширенная аналитика и ежедневные сводки'] },
    ],
    ai: {
      title: 'Ответы ИИ простыми словами',
      text: 'Ответ — это ответ пациенту, подготовленный черновик или запрос к помощнику руководителя. В кабинете видно «Использовано 180 из 500», остаток и кнопку докупить. Когда ответы заканчиваются, ИИ передаёт разговор сотруднику, долга нет. Купленные ответы переносятся на следующие месяцы.',
      pack: 'Дополнительный пакет: 500 ответов за 390 грн',
    },
    noTrial: 'Бесплатного периода нет: вместо него демо на выдуманных данных. Доступ к данным вашей клиники открывается после оплаты.',
    cta: 'Подключить клинику',
  },
  steps: {
    title: 'Как подключиться',
    items: [
      { t: 'Смотрите демо', d: 'Без регистрации, на выдуманных данных.' },
      { t: 'Регистрируетесь и оплачиваете', d: 'Подключение и первый месяц тарифа.' },
      { t: 'Даёте ключ Cliniccards', d: 'Данные загружаются сами, начиная с первых минут.' },
      { t: 'Подключаем каналы', d: 'Мессенджеры настраиваем вместе, вы только подтверждаете доступы.' },
    ],
  },
  security: {
    title: 'Безопасность и данные пациентов',
    items: [
      'Cliniccards мы только читаем: ничего там не меняем без вашего решения.',
      'Ключи и токены хранятся зашифрованными.',
      'Данные каждой клиники полностью отделены от других.',
      'Роли: врач не видит деньги, доступ сотрудника закрывается сразу.',
      'Двухфакторный вход и журнал действий, включая просмотры карточек и выгрузки.',
      'Имена и телефоны пациентов не передаются ИИ. Опасные темы ИИ передаёт человеку.',
      'Экспорт своих данных доступен на любом тарифе.',
    ],
  },
  faq: {
    title: 'Частые вопросы',
    items: [
      { q: 'Нужно ли отказываться от Cliniccards?', a: 'Нет. Cliniccards остаётся основной системой, а LANKA читает из неё данные и добавляет отчёты, автоматизацию и общение.' },
      { q: 'Может ли ИИ ошибиться?', a: 'Расчёты в отчётах делает код. В разговорах у ИИ жёсткие границы: он не обсуждает здоровье, скидки и жалобы, цены называет только из утверждённого клиникой перечня, а время предлагает только из реальных свободных окон. Всё сомнительное уходит человеку.' },
      { q: 'Не будут ли пациенты получать спам?', a: 'Нет. Реклама требует согласия, не чаще одного раза в 14 дней, только в удобные часы, и есть «Остановить». Сообщения по умолчанию подтверждает сотрудник.' },
      { q: 'Как пациенты попадают в бота?', a: 'Мессенджер разрешает писать только тем, кто сам нажал «Старт». Поэтому мы даём QR-код и персональные ссылки для ресепшн, а охват растёт постепенно.' },
      { q: 'Что будет, если закончатся ответы ИИ?', a: 'ИИ передаст разговор сотруднику. Можно докупить пакет. Долг не накапливается.' },
      { q: 'Где хранятся данные?', a: 'В защищённой базе данных сервиса, отдельно для каждой клиники. Условия обработки данных принимаются при регистрации.' },
    ],
  },
  final: { title: 'Посмотрите, как это работает в клинике', text: 'Откройте демо за минуту или подключите свою клинику.' },
  mock: {
    report: 'Пациенты без следующей записи',
    chatIn: 'Добрый день! Хочу на чистку.',
    chatOut: 'Конечно! Выберите удобное время кнопкой ниже, а администратор подтвердит запись.',
    slots: ['Вт 03.11, 10:00', 'Вт 03.11, 14:30', 'Ср 04.11, 09:00'],
    funnel: ['Обращения', 'Записались', 'Пришли', 'Лечение'],
    rules: ['Напоминание о визите', 'Возврат «давно не были»', 'Оценка визита'],
    rows: [['Коваленко О.', '8 мес.', 'Чистка'], ['Шевченко А.', '11 мес.', 'Осмотр'], ['Бондаренко М.', '14 мес.', 'Лечение']],
  },
  footer: '© LANKA. Сервис для стоматологических клиник на Cliniccards.',
};

const en: LandingText = {
  nav: { features: 'Features', demo: 'Demo', integrations: 'Integrations', pricing: 'Pricing', faq: 'FAQ', login: 'Sign in', terms: 'Terms', privacy: 'Privacy' },
  hero: {
    title: 'A Cliniccards clinic without the manual routine',
    sub: 'LANKA takes data from Cliniccards and prepares reports, reminds patients, answers messages and shows where the clinic loses people. The administrator only confirms.',
    demo: 'View the demo',
    connect: 'Connect your clinic',
    note: 'The demo runs on made-up data and needs no sign-up.',
  },
  result: {
    title: 'What changes for the clinic',
    items: [
      { t: 'Reports without spreadsheets', d: 'Who has no next visit, who did not come, debts, free slots: with Excel and PDF, the calculation rule and the data date.' },
      { t: 'AI administrator', d: 'Answers in the messenger, offers times from the real schedule and hands over to a person what it must not decide.' },
      { t: 'Fewer lost patients', d: 'Reminders, win-back of lapsed patients, visit rating: all through scenarios you control.' },
      { t: 'The whole path is visible', d: 'From the first inquiry to the visit and payment: where people stop and what that costs you.' },
    ],
  },
  features: [
    { id: 'reports', title: 'Reports and a builder', text: 'Nine ready reports and a builder for your own. Code does the calculations, not AI, so you can trust the numbers.', points: ['Excel, PDF and CSV in one click', 'Every report shows its rule and update date', 'Ask the assistant in words: it assembles the report, the system calculates'] },
    { id: 'ai', title: 'AI answers patients', text: 'A patient writes in a messenger, the AI answers in seconds, and difficult or sensitive questions go straight to a person.', points: ['Appointment times are offered as buttons from the free slots', 'The AI does not decide questions on health and complaints, and quotes prices only from the list you approved', 'Patient names and phones are never sent to the model'] },
    { id: 'booking', title: 'Booking without calls', text: 'The AI collects the patient’s wishes, picks a time from the schedule and prepares a request that the administrator confirms in seconds.', points: ['Requests are collected in one list', 'The time the patient picked is visible to the administrator at once', 'Cliniccards stays the main system'] },
    { id: 'auto', title: 'Automations', text: 'Visit reminders, win-back, birthdays, thanks and rating: ready scenarios with confirmation before sending.', points: ['At most one promotion per patient in 14 days', 'Messages only at convenient hours', 'A log: what, to whom and why it was not sent'] },
    { id: 'funnel', title: 'Patient funnel', text: 'See the path from inquiry to treatment and return, patient sources and where they drop off, with lists of people.', points: ['Cohorts and sources', 'Mailing results: who booked after a message', 'Weekly summaries for the manager in Telegram'] },
  ],
  demo: {
    title: 'Try it yourself, no sign-up',
    text: 'Press the button: you get your own copy of a made-up clinic with patients, appointments, reports and conversations. Nothing in it is real and messages are only simulated.',
    steps: ['Open a report and download it to Excel', 'In the Inbox ask the AI to prepare a reply', 'Look at the funnel and patient ratings'],
    cta: 'Open the demo',
  },
  integrations: {
    title: 'Integrations',
    sub: 'The “Working” list contains only what has been checked on a real connection. The rest is being connected and will be added here as it is verified.',
    live: 'Working',
    soon: 'Connecting',
    list: [
      { name: 'Cliniccards', what: 'Reading patients, visits, treatment plans and payments', live: true },
      { name: 'Email', what: 'Reports and notifications by email', live: true },
      { name: 'Telegram', what: 'The clinic bot: reminders, replies, requests', live: false },
      { name: 'Instagram', what: 'Replies to Direct messages', live: false },
      { name: 'Facebook Messenger', what: 'Replies to page messages', live: false },
      { name: 'WhatsApp', what: 'Official Meta connection', live: false },
      { name: 'Viber', what: 'Two-way Viber Business chat', live: false },
      { name: 'Clinic website chat', what: 'A widget answered by the same AI', live: false },
      { name: 'Binotel, Ringostat', what: 'Call history and missed inquiries', live: false },
      { name: 'Google Sheets', what: 'Updating selected spreadsheets', live: false },
      { name: 'Meta Lead Ads', what: 'Leads from advertising forms', live: false },
      { name: 'LiqPay', what: 'Payment for LANKA and extra AI replies', live: false },
    ],
  },
  pricing: {
    title: 'Pricing',
    sub: 'One price per clinic, no charge per patient.',
    setup: 'Connection $99 one-off',
    setupText: 'We connect Cliniccards, set the clinic up and help with the channels. Paid together with the first month.',
    perMonth: 'UAH/month',
    plans: [
      { name: 'Start', price: '1,990', lines: ['Up to 10 staff', '2,000 automatic messages per month', '500 AI replies per month', 'Reports, builder, manager assistant', 'Telegram and automations with confirmation'] },
      { name: 'Pro', price: '3,990', pro: true, lines: ['Up to 30 staff', '10,000 automatic messages per month', '3,000 AI replies per month', 'Everything in Start', 'The AI answers patients on its own', 'Several channels', 'Extended analytics and daily summaries'] },
    ],
    ai: {
      title: 'AI replies in plain words',
      text: 'A reply is an answer to a patient, a prepared draft or a request to the manager assistant. The workspace shows “Used 180 of 500”, what is left and a button to buy more. When replies run out the AI hands the conversation to staff and no debt builds up. Bought replies carry over to the next months.',
      pack: 'Extra pack: 500 replies for 390 UAH',
    },
    noTrial: 'There is no free period: there is a demo on made-up data instead. Access to your clinic’s data opens after payment.',
    cta: 'Connect your clinic',
  },
  steps: {
    title: 'How to get started',
    items: [
      { t: 'Look at the demo', d: 'No sign-up, made-up data.' },
      { t: 'Register and pay', d: 'The connection and the first month.' },
      { t: 'Give the Cliniccards key', d: 'The data loads on its own from the first minutes.' },
      { t: 'We connect the channels', d: 'We set the messengers up together; you only confirm access.' },
    ],
  },
  security: {
    title: 'Security and patient data',
    items: [
      'We only read Cliniccards: nothing is changed there without your decision.',
      'Keys and tokens are stored encrypted.',
      'Each clinic’s data is completely separated from the others.',
      'Roles: a doctor does not see money, a former employee loses access at once.',
      'Two-factor sign-in and an action log, including card views and exports.',
      'Patient names and phones are never given to the AI. Dangerous topics go to a person.',
      'Exporting your own data is available on every plan.',
    ],
  },
  faq: {
    title: 'Frequently asked questions',
    items: [
      { q: 'Do I have to give up Cliniccards?', a: 'No. Cliniccards stays the main system; LANKA reads its data and adds reports, automation and communication.' },
      { q: 'Can the AI make a mistake?', a: 'Report calculations are done by code. In conversations the AI has hard limits: it does not discuss health, discounts and complaints, quotes prices only from the list the clinic approved, and offers times only from real free slots. Anything doubtful goes to a person.' },
      { q: 'Will patients get spam?', a: 'No. Promotions need consent, at most once in 14 days, only at convenient hours, and there is a “Stop”. Staff confirm messages by default.' },
      { q: 'How do patients get into the bot?', a: 'A messenger lets you write only to people who pressed “Start” themselves. So we give you a QR code and personal links for the front desk, and coverage grows gradually.' },
      { q: 'What happens when AI replies run out?', a: 'The AI hands the conversation to staff. You can buy a pack. No debt builds up.' },
      { q: 'Where is the data stored?', a: 'In the service’s protected database, separately for each clinic. The data processing terms are accepted at sign-up.' },
    ],
  },
  final: { title: 'See how it works in a clinic', text: 'Open the demo in a minute or connect your clinic.' },
  mock: {
    report: 'Patients without a next visit',
    chatIn: 'Good afternoon! I want a cleaning.',
    chatOut: 'Of course! Pick a convenient time with the button below and the administrator will confirm the booking.',
    slots: ['Tue 03.11, 10:00', 'Tue 03.11, 14:30', 'Wed 04.11, 09:00'],
    funnel: ['Inquiries', 'Booked', 'Came', 'Treatment'],
    rules: ['Visit reminder', 'Win-back of lapsed patients', 'Visit rating'],
    rows: [['Kovalenko O.', '8 mo.', 'Cleaning'], ['Shevchenko A.', '11 mo.', 'Check-up'], ['Bondarenko M.', '14 mo.', 'Treatment']],
  },
  footer: '© LANKA. A service for dental clinics on Cliniccards.',
};

export const LANDING: Record<Locale, LandingText> = { uk, ru, en };
