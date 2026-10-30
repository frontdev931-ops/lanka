import { ArgumentsHost, Catch, ExceptionFilter, HttpException, createParamDecorator, ExecutionContext } from '@nestjs/common';

export type Lang = 'uk' | 'ru' | 'en';
export const DEFAULT_LANG: Lang = 'uk';

// Язык берётся из заголовка Accept-Language, который отправляет веб-клиент (uk | ru | en)
export function langFromHeader(h?: string | string[]): Lang {
  const v = (Array.isArray(h) ? h[0] : h ?? '').toLowerCase().slice(0, 2);
  return v === 'ru' || v === 'en' || v === 'uk' ? v : DEFAULT_LANG;
}

export const ReqLang = createParamDecorator((_: unknown, ctx: ExecutionContext): Lang =>
  langFromHeader(ctx.switchToHttp().getRequest().headers['accept-language']),
);

// ---------- ошибки ----------
// В коде бросаются ключи (например 'bad_api_key'), фильтр подменяет их текстом на языке запроса.
const ERRORS: Record<string, Record<Lang, string>> = {
  email_taken: {
    uk: 'Користувач з таким email вже існує',
    ru: 'Пользователь с таким email уже есть',
    en: 'A user with this email already exists',
  },
  too_many_attempts: {
    uk: 'Забагато спроб входу. Спробуйте через 15 хвилин',
    ru: 'Слишком много попыток входа. Попробуйте через 15 минут',
    en: 'Too many login attempts. Try again in 15 minutes',
  },
  bad_credentials: {
    uk: 'Неправильний email або пароль',
    ru: 'Неверный email или пароль',
    en: 'Wrong email or password',
  },
  no_clinic_access: {
    uk: 'Немає доступу до цієї клініки',
    ru: 'Нет доступа к этой клинике',
    en: 'No access to this clinic',
  },
  bad_api_key: {
    uk: 'Ключ не підійшов: Cliniccards його не прийняв',
    ru: 'Ключ не подошёл: Cliniccards его не принял',
    en: 'The key was rejected by Cliniccards',
  },
  assignee_not_member: {
    uk: 'Виконавець не з цієї клініки',
    ru: 'Исполнитель не из этой клиники',
    en: 'The assignee does not belong to this clinic',
  },
  patient_not_found: {
    uk: 'Пацієнта не знайдено',
    ru: 'Пациент не найден',
    en: 'Patient not found',
  },
  task_not_found: {
    uk: 'Завдання не знайдено',
    ru: 'Задача не найдена',
    en: 'Task not found',
  },
  report_no_tasks: {
    uk: 'З цього звіту завдання не створюються',
    ru: 'Из этого отчёта задачи не создаются',
    en: 'Tasks cannot be created from this report',
  },
  report_not_found: {
    uk: 'Звіт не знайдено',
    ru: 'Отчёт не найден',
    en: 'Report not found',
  },
  owner_role: {
    uk: 'Роль власника видати не можна',
    ru: 'Роль владельца выдать нельзя',
    en: 'The owner role cannot be granted',
  },
  forbidden: {
    uk: 'Недостатньо прав для цієї дії',
    ru: 'Недостаточно прав для этого действия',
    en: 'You do not have permission to do this',
  },
  unauthorized: {
    uk: 'Потрібно увійти в систему',
    ru: 'Нужно войти в систему',
    en: 'Please sign in',
  },
  invite_invalid: {
    uk: 'Запрошення недійсне або термін його дії минув',
    ru: 'Приглашение недействительно или срок его действия истёк',
    en: 'The invitation is invalid or has expired',
  },
  name_required: {
    uk: "Вкажіть ім'я",
    ru: 'Укажите имя',
    en: 'Please enter your name',
  },
  import_not_found: {
    uk: 'Імпорт не знайдено',
    ru: 'Импорт не найден',
    en: 'Import not found',
  },
  import_done: {
    uk: 'Цей імпорт уже застосовано',
    ru: 'Этот импорт уже применён',
    en: 'This import has already been applied',
  },
  bad_file: {
    uk: 'Не вдалося прочитати файл. Підтримуються .xlsx та .csv',
    ru: 'Не удалось прочитать файл. Поддерживаются .xlsx и .csv',
    en: 'Could not read the file. Supported formats: .xlsx and .csv',
  },
  file_too_big: {
    uk: 'Файл завеликий: не більше 5 МБ і 20 000 рядків',
    ru: 'Файл слишком большой: не более 5 МБ и 20 000 строк',
    en: 'The file is too large: up to 5 MB and 20,000 rows',
  },
  bad_mapping: {
    uk: 'Невірні налаштування відповідності стовпців',
    ru: 'Неверные настройки соответствия столбцов',
    en: 'Invalid column mapping',
  },
  wrong_confirmation: {
    uk: 'Назву клініки або пароль введено неправильно',
    ru: 'Название клиники или пароль введены неверно',
    en: 'The clinic name or password is incorrect',
  },
  inquiry_empty: {
    uk: 'Вкажіть хоча б телефон, ім’я або примітку',
    ru: 'Укажите хотя бы телефон, имя или заметку',
    en: 'Enter at least a phone, a name or a note',
  },
  inquiry_future: {
    uk: 'Дата звернення в майбутньому: перевірте дату',
    ru: 'Дата обращения в будущем: проверьте дату',
    en: 'The inquiry date is in the future: check the date',
  },
  inquiry_not_found: {
    uk: 'Звернення не знайдено',
    ru: 'Обращение не найдено',
    en: 'Inquiry not found',
  },
  bad_bot_token: {
    uk: 'Telegram не прийняв ключ бота: перевірте, що скопійовано весь ключ від @BotFather',
    ru: 'Telegram не принял ключ бота: проверьте, что скопирован весь ключ от @BotFather',
    en: 'Telegram rejected the bot token: check that you copied the whole token from @BotFather',
  },
  bad_instagram_token: {
    uk: 'Instagram не прийняв ключ доступу: перевірте, що скопійовано весь токен акаунта',
    ru: 'Instagram не принял ключ доступа: проверьте, что скопирован весь токен аккаунта',
    en: 'Instagram rejected the access token: check that you copied the whole account token',
  },
  instagram_taken: {
    uk: 'Цей акаунт Instagram уже підключено до іншої клініки',
    ru: 'Этот аккаунт Instagram уже подключён к другой клинике',
    en: 'This Instagram account is already connected to another clinic',
  },
  bad_facebook_token: {
    uk: 'Facebook не прийняв ключ сторінки: перевірте, що скопійовано весь токен',
    ru: 'Facebook не принял ключ страницы: проверьте, что скопирован весь токен',
    en: 'Facebook rejected the page token: check that you copied the whole token',
  },
  bad_whatsapp_token: {
    uk: 'WhatsApp не прийняв ключ або номер: перевірте токен і ідентифікатор номера',
    ru: 'WhatsApp не принял ключ или номер: проверьте токен и идентификатор номера',
    en: 'WhatsApp rejected the token or the number: check the token and the phone number id',
  },
  bad_whatsapp_number_id: {
    uk: 'Ідентифікатор номера WhatsApp має складатися з цифр',
    ru: 'Идентификатор номера WhatsApp должен состоять из цифр',
    en: 'The WhatsApp phone number id must be digits',
  },
  bad_viber_credentials: {
    uk: 'Viber не прийняв дані підключення',
    ru: 'Viber не принял данные подключения',
    en: 'Viber rejected the connection details',
  },
  viber_provider_not_chosen: {
    uk: 'Підключення Viber ще готується: партнера для Viber Business обрано не завершено',
    ru: 'Подключение Viber ещё готовится: партнёр для Viber Business ещё не выбран',
    en: 'Viber is not available yet: the Viber Business partner has not been chosen',
  },
  channel_not_connected: {
    uk: 'Цей канал не підключено на сторінці «Автоматизації»',
    ru: 'Этот канал не подключён на странице «Автоматизации»',
    en: 'This channel is not connected on the Automations page',
  },
  bad_widget_origin: {
    uk: 'Адреса сайту має бути у форматі https://приклад.com (до 10 адрес)',
    ru: 'Адрес сайта должен быть в формате https://пример.com (до 10 адресов)',
    en: 'A site address must look like https://example.com (up to 10)',
  },
  bad_widget_text: {
    uk: 'Повідомлення порожнє або задовге',
    ru: 'Сообщение пустое или слишком длинное',
    en: 'The message is empty or too long',
  },
  webchat_unavailable: {
    uk: 'Чат тимчасово недоступний',
    ru: 'Чат временно недоступен',
    en: 'The chat is temporarily unavailable',
  },
  channel_account_taken: {
    uk: 'Цей акаунт уже підключено до іншої клініки',
    ru: 'Этот аккаунт уже подключён к другой клинике',
    en: 'This account is already connected to another clinic',
  },
  instagram_oauth_not_ready: {
    uk: 'Підключення Instagram через вхід ще не налаштоване власником сервісу',
    ru: 'Подключение Instagram через вход ещё не настроено владельцем сервиса',
    en: 'Instagram sign-in is not set up by the service owner yet',
  },
  instagram_oauth_denied: {
    uk: 'Доступ до Instagram не надано. Можна спробувати ще раз',
    ru: 'Доступ к Instagram не предоставлен. Можно попробовать ещё раз',
    en: 'Instagram access was not granted. You can try again',
  },
  instagram_oauth_failed: {
    uk: 'Не вдалося підключити Instagram. Спробуйте ще раз',
    ru: 'Не удалось подключить Instagram. Попробуйте ещё раз',
    en: 'Could not connect Instagram. Try again',
  },
  instagram_not_connected: {
    uk: 'Спочатку підключіть Instagram на сторінці «Автоматизації»',
    ru: 'Сначала подключите Instagram на странице «Автоматизации»',
    en: 'Connect Instagram on the Automations page first',
  },
  window_closed: {
    uk: 'Минуло понад 24 години після останнього повідомлення людини: Instagram не дозволяє відповісти. Чекайте нового повідомлення.',
    ru: 'Прошло больше 24 часов после последнего сообщения человека: Instagram не позволяет ответить. Дождитесь нового сообщения.',
    en: 'More than 24 hours have passed since the person’s last message: Instagram does not allow a reply. Wait for a new message.',
  },
  event_not_found: {
    uk: 'Подію не знайдено або її не потрібно повторювати',
    ru: 'Событие не найдено или его не нужно повторять',
    en: 'The event was not found or does not need a retry',
  },
  plan_feature: {
    uk: 'Ця можливість входить у тариф «Про»',
    ru: 'Эта возможность входит в тариф «Про»',
    en: 'This feature is part of the Pro plan',
  },
  payment_required: {
    uk: 'Щоб працювати з даними клініки, оплатіть підключення на сторінці «Оплата»',
    ru: 'Чтобы работать с данными клиники, оплатите подключение на странице «Оплата»',
    en: 'To work with your clinic data, pay for the connection on the Billing page',
  },
  billing_not_configured: {
    uk: 'Онлайн-оплата ще не налаштована',
    ru: 'Онлайн-оплата ещё не настроена',
    en: 'Online payment is not set up yet',
  },
  fx_unavailable: {
    uk: 'Не вдалося отримати курс долара: спробуйте за кілька хвилин',
    ru: 'Не удалось получить курс доллара: попробуйте через несколько минут',
    en: 'Could not get the dollar rate: try again in a few minutes',
  },
  pack_cap: {
    uk: 'Досягнуто місячний ліміт покупок додаткових відповідей',
    ru: 'Достигнут месячный лимит покупок дополнительных ответов',
    en: 'The monthly limit of extra reply packs is reached',
  },
  bad_signature: {
    uk: 'Невірний підпис',
    ru: 'Неверная подпись',
    en: 'Invalid signature',
  },
  bad_plan: {
    uk: 'Невідомий тариф',
    ru: 'Неизвестный тариф',
    en: 'Unknown plan',
  },
  demo_restricted: {
    uk: 'У демо це недоступне: воно працює на вигаданих даних',
    ru: 'В демо это недоступно: оно работает на выдуманных данных',
    en: 'This is not available in the demo: it runs on made-up data',
  },
  demo_busy: {
    uk: 'Демо зараз зайняте, спробуйте за кілька хвилин',
    ru: 'Демо сейчас занято, попробуйте через несколько минут',
    en: 'The demo is busy right now, try again in a few minutes',
  },
  booking_write_disabled: {
    uk: 'Запис у систему клініки не ввімкнено',
    ru: 'Запись в систему клиники не включена',
    en: 'Writing to the clinic system is not enabled',
  },
  booking_bad_time: {
    uk: 'Невірний час запису: він має бути в майбутньому, кратним 5 хвилинам і в межах одного дня',
    ru: 'Неверное время записи: оно должно быть в будущем, кратным 5 минутам и в пределах одного дня',
    en: 'Invalid appointment time: it must be in the future, a multiple of 5 minutes and within one day',
  },
  booking_slot_taken: {
    uk: 'Цей час уже зайнято: оновіть вільні вікна й оберіть інший',
    ru: 'Это время уже занято: обновите свободные окна и выберите другое',
    en: 'This time is already taken: refresh the free slots and pick another',
  },
  booking_slot_blocked: {
    uk: 'У цей час кабінет закрито в розкладі',
    ru: 'В это время кабинет закрыт в расписании',
    en: 'The cabinet is blocked in the schedule at this time',
  },
  booking_patient_busy: {
    uk: 'У пацієнта вже є запис на цей час',
    ru: 'У пациента уже есть запись на это время',
    en: 'The patient already has an appointment at this time',
  },
  booking_in_progress: {
    uk: 'Цей запис уже виконується, зачекайте хвилину',
    ru: 'Эта запись уже выполняется, подождите минуту',
    en: 'This booking is already in progress, wait a minute',
  },
  booking_unknown: {
    uk: 'Не вдалося дізнатися, чи збереглася дія в Cliniccards. Перевірте розклад у Cliniccards вручну, не повторюйте запис.',
    ru: 'Не удалось узнать, сохранилось ли действие в Cliniccards. Проверьте расписание в Cliniccards вручную, не повторяйте запись.',
    en: 'We could not find out whether the action was saved in Cliniccards. Check the schedule in Cliniccards by hand and do not repeat it.',
  },
  booking_failed: {
    uk: 'Cliniccards не прийняв запис. Нічого не збережено, перевірте дані й спробуйте ще раз.',
    ru: 'Cliniccards не принял запись. Ничего не сохранено, проверьте данные и попробуйте ещё раз.',
    en: 'Cliniccards did not accept the booking. Nothing was saved; check the data and try again.',
  },
  booking_check_failed: {
    uk: 'Не вдалося перевірити розклад у Cliniccards, тому запис не створено',
    ru: 'Не удалось проверить расписание в Cliniccards, поэтому запись не создана',
    en: 'The schedule in Cliniccards could not be checked, so nothing was booked',
  },
  visit_not_changeable: {
    uk: 'Цей візит вже не можна змінити (він минув або має інший статус)',
    ru: 'Этот визит уже нельзя изменить (он прошёл или имеет другой статус)',
    en: 'This visit can no longer be changed (it is past or has another status)',
  },
  patient_exists_in_clinic: {
    uk: 'Пацієнт з таким телефоном уже є в Cliniccards: оновіть дані та знайдіть його',
    ru: 'Пациент с таким телефоном уже есть в Cliniccards: обновите данные и найдите его',
    en: 'A patient with this phone already exists in Cliniccards: refresh the data and find them',
  },
  patient_name_needed: {
    uk: 'Вкажіть прізвище та ім’я пацієнта',
    ru: 'Укажите фамилию и имя пациента',
    en: 'Enter the patient’s surname and first name',
  },
  bad_phone: {
    uk: 'Невірний номер телефону',
    ru: 'Неверный номер телефона',
    en: 'Invalid phone number',
  },
  kb_not_found: {
    uk: 'Запис довідки не знайдено',
    ru: 'Запись справки не найдена',
    en: 'The knowledge entry was not found',
  },
  kb_full: {
    uk: 'У довідці вже забагато записів',
    ru: 'В справке уже слишком много записей',
    en: 'The knowledge base is full',
  },
  kb_price_needed: {
    uk: 'Спершу вкажіть ціну в гривнях: ціну з Cliniccards треба підтвердити вручну',
    ru: 'Сначала укажите цену в гривнах: цену из Cliniccards нужно подтвердить вручную',
    en: 'Enter the price in hryvnias first: a price from Cliniccards must be confirmed by hand',
  },
  kb_import_unavailable: {
    uk: 'Імпорт послуг доступний після підключення Cliniccards',
    ru: 'Импорт услуг доступен после подключения Cliniccards',
    en: 'Importing services is available after Cliniccards is connected',
  },
  kb_import_failed: {
    uk: 'Не вдалося отримати прайс із Cliniccards',
    ru: 'Не удалось получить прайс из Cliniccards',
    en: 'Could not get the price list from Cliniccards',
  },
  bad_kb_kind: { uk: 'Невірний вид запису', ru: 'Неверный вид записи', en: 'Invalid entry type' },
  bad_kb_title: { uk: 'Назва має бути від 1 до 160 символів', ru: 'Название должно быть от 1 до 160 символов', en: 'The title must be 1 to 160 characters' },
  bad_kb_text: { uk: 'Текст задовгий (до 900 символів)', ru: 'Текст слишком длинный (до 900 символов)', en: 'The text is too long (up to 900 characters)' },
  bad_kb_number: { uk: 'Невірне число (ціна або тривалість)', ru: 'Неверное число (цена или длительность)', en: 'Invalid number (price or duration)' },
  bad_schedule: { uk: 'Невірний розклад відправки', ru: 'Неверное расписание отправки', en: 'Invalid sending schedule' },
  bad_recipients: { uk: 'Оберіть від 1 до 5 співробітників клініки', ru: 'Выберите от 1 до 5 сотрудников клиники', en: 'Pick 1 to 5 members of the clinic' },
  bad_alert: { uk: 'Невірні значення сигналу', ru: 'Неверные значения сигнала', en: 'Invalid alert values' },
  alert_not_found: { uk: 'Такого сигналу немає', ru: 'Такого сигнала нет', en: 'No such alert' },
  bad_waitlist: { uk: 'Невірні побажання для списку очікування', ru: 'Неверные пожелания для листа ожидания', en: 'Invalid wishes for the waiting list' },
  waitlist_full: { uk: 'Список очікування переповнений', ru: 'Лист ожидания переполнен', en: 'The waiting list is full' },
  waitlist_exists: { uk: 'Цей пацієнт уже в списку очікування', ru: 'Этот пациент уже в листе ожидания', en: 'This patient is already on the waiting list' },
  waitlist_not_found: { uk: 'Запис списку очікування не знайдено', ru: 'Запись листа ожидания не найдена', en: 'The waiting list entry was not found' },
  bad_automation: { uk: 'Невірні параметри автоматизації', ru: 'Неверные параметры автоматизации', en: 'Invalid automation settings' },
  automation_limit: { uk: 'Забагато автоматизацій (до 20)', ru: 'Слишком много автоматизаций (до 20)', en: 'Too many automations (up to 20)' },
  automation_not_found: { uk: 'Автоматизацію не знайдено', ru: 'Автоматизация не найдена', en: 'Automation not found' },
  platform_2fa_required: { uk: 'Для огляду сервісу ввімкніть двофакторний вхід у налаштуваннях безпеки', ru: 'Для обзора сервиса включите двухфакторный вход в настройках безопасности', en: 'To use the service overview turn on two-factor sign-in in the security settings' },
  meta_oauth_not_ready: { uk: 'Підключення через Facebook ще не налаштоване власником сервісу', ru: 'Подключение через Facebook ещё не настроено владельцем сервиса', en: 'Connecting through Facebook is not set up by the service owner yet' },
  meta_oauth_denied: { uk: 'Доступ до Facebook не надано. Можна спробувати ще раз', ru: 'Доступ к Facebook не предоставлен. Можно попробовать ещё раз', en: 'Facebook access was not granted. You can try again' },
  meta_oauth_failed: { uk: 'Не вдалося підключити Facebook. Спробуйте ще раз', ru: 'Не удалось подключить Facebook. Попробуйте ещё раз', en: 'Could not connect Facebook. Try again' },
  meta_no_pages: { uk: 'У вибраному доступі немає сторінки Facebook: оберіть сторінку клініки в діалозі Facebook', ru: 'В выбранном доступе нет страницы Facebook: выберите страницу клиники в диалоге Facebook', en: 'The access you gave has no Facebook page: pick the clinic page in the Facebook dialog' },
  meta_no_permissions: { uk: 'У доступі, який ви надали, немає дозволів на повідомлення Instagram чи Messenger. Підключіть знову й залиште потрібні дозволи в діалозі Facebook', ru: 'В доступе, который вы предоставили, нет разрешений на сообщения Instagram или Messenger. Подключите заново и оставьте нужные разрешения в диалоге Facebook', en: 'The access you gave has no permission for Instagram or Messenger messages. Connect again and keep the permissions in the Facebook dialog' },
  meta_session_expired: { uk: 'Сеанс підключення закінчився: почніть підключення знову', ru: 'Сеанс подключения закончился: начните подключение заново', en: 'The connection session ended: start connecting again' },
  meta_subscribe_denied: { uk: 'Facebook не дозволив підписатися на повідомлення сторінки: перевірте дозволи застосунку', ru: 'Facebook не разрешил подписаться на сообщения страницы: проверьте разрешения приложения', en: 'Facebook did not allow subscribing to the page messages: check the app permissions' },
  meta_subscribe_failed: { uk: 'Не вдалося підписатися на повідомлення сторінки. Спробуйте ще раз', ru: 'Не удалось подписаться на сообщения страницы. Попробуйте ещё раз', en: 'Could not subscribe to the page messages. Try again' },
  bot_not_connected: {
    uk: 'Спочатку підключіть Telegram-бота на сторінці «Автоматизації»',
    ru: 'Сначала подключите Telegram-бота на странице «Автоматизации»',
    en: 'Connect the Telegram bot on the Automations page first',
  },
  bad_scenario: {
    uk: 'Невідомий сценарій',
    ru: 'Неизвестный сценарий',
    en: 'Unknown scenario',
  },
  bad_params: {
    uk: 'Невірні параметри сценарію (години від 1 до 72, місяці від 1 до 24)',
    ru: 'Неверные параметры сценария (часы от 1 до 72, месяцы от 1 до 24)',
    en: 'Invalid scenario settings (hours 1–72, months 1–24)',
  },
  bad_template: {
    uk: 'У тексті невідома змінна. Дозволено: {name}, {clinic}, {date}, {time}, {months}',
    ru: 'В тексте неизвестная переменная. Разрешено: {name}, {clinic}, {date}, {time}, {months}',
    en: 'The text has an unknown variable. Allowed: {name}, {clinic}, {date}, {time}, {months}',
  },
  bad_spec: {
    uk: 'Невірний опис звіту',
    ru: 'Неверное описание отчёта',
    en: 'Invalid report definition',
  },
  campaign_not_found: {
    uk: 'Розсилку не знайдено або її вже поставлено в чергу',
    ru: 'Рассылка не найдена или уже поставлена в очередь',
    en: 'Campaign not found or already queued',
  },
  too_many_saved: {
    uk: 'Забагато збережених звітів (максимум 100)',
    ru: 'Слишком много сохранённых отчётов (максимум 100)',
    en: 'Too many saved reports (maximum 100)',
  },
  assistant_disabled: {
    uk: 'ШІ-помічник керівника вимкнений. Увімкніть його на сторінці «Автоматизації».',
    ru: 'ИИ-помощник руководителя выключен. Включите его на странице «Автоматизации».',
    en: 'The manager AI assistant is off. Turn it on on the Automations page.',
  },
  bad_review_url: {
    uk: 'Посилання на відгук має починатися з https://',
    ru: 'Ссылка на отзыв должна начинаться с https://',
    en: 'The review link must start with https://',
  },
  twofa_already: {
    uk: 'Двофакторний вхід уже ввімкнено',
    ru: 'Двухфакторный вход уже включён',
    en: 'Two-factor sign-in is already on',
  },
  twofa_not_started: {
    uk: 'Спочатку створіть ключ для застосунку-автентифікатора',
    ru: 'Сначала создайте ключ для приложения-аутентификатора',
    en: 'Create the authenticator key first',
  },
  twofa_not_enabled: {
    uk: 'Двофакторний вхід не ввімкнено',
    ru: 'Двухфакторный вход не включён',
    en: 'Two-factor sign-in is not on',
  },
  twofa_bad_code: {
    uk: 'Невірний код. Введіть 6 цифр із застосунку або резервний код',
    ru: 'Неверный код. Введите 6 цифр из приложения или резервный код',
    en: 'Wrong code. Enter the 6 digits from the app or a recovery code',
  },
  clinic_suspended: {
    uk: 'Доступ клініки призупинено. Зверніться до підтримки сервісу',
    ru: 'Доступ клиники приостановлен. Обратитесь в поддержку сервиса',
    en: 'The clinic access is suspended. Contact the service support',
  },
  twofa_required: {
    uk: 'Власник клініки вимагає двофакторний вхід. Увімкніть його в налаштуваннях',
    ru: 'Владелец клиники требует двухфакторный вход. Включите его в настройках',
    en: 'The clinic owner requires two-factor sign-in. Turn it on in settings',
  },
  twofa_owner_first: {
    uk: 'Спочатку увімкніть двофакторний вхід для себе',
    ru: 'Сначала включите двухфакторный вход для себя',
    en: 'Turn on two-factor sign-in for yourself first',
  },
  plan_users_limit: {
    uk: 'Ліміт співробітників за тарифом вичерпано',
    ru: 'Лимит сотрудников по тарифу исчерпан',
    en: 'The staff limit of the plan is reached',
  },
  last_owner: {
    uk: 'Власника клініки не можна видалити або змінити',
    ru: 'Владельца клиники нельзя удалить или изменить',
    en: 'The clinic owner cannot be removed or changed',
  },
  import_not_undoable: {
    uk: 'Цей імпорт не можна скасувати (він не застосований або вже скасований)',
    ru: 'Этот импорт нельзя отменить (он не применён или уже отменён)',
    en: 'This import cannot be undone (it is not applied or already undone)',
  },
  nothing_selected: {
    uk: 'Нічого не вибрано',
    ru: 'Ничего не выбрано',
    en: 'Nothing selected',
  },
  bad_reason: {
    uk: 'Невідомий перехід воронки',
    ru: 'Неизвестный переход воронки',
    en: 'Unknown funnel step',
  },
  wrong_current_password: {
    uk: 'Поточний пароль введено невірно',
    ru: 'Текущий пароль введён неверно',
    en: 'The current password is incorrect',
  },
  same_password: {
    uk: 'Новий пароль збігається з поточним',
    ru: 'Новый пароль совпадает с текущим',
    en: 'The new password is the same as the current one',
  },
  same_email: {
    uk: 'Це вже ваша пошта',
    ru: 'Это уже ваша почта',
    en: 'This is already your email',
  },
  weak_password: {
    uk: 'Пароль занадто простий: потрібно щонайменше 10 символів, і він не має збігатися з поштою',
    ru: 'Пароль слишком простой: нужно не меньше 10 символов, и он не должен совпадать с почтой',
    en: 'The password is too weak: use at least 10 characters and not your email',
  },
  bad_token: {
    uk: 'Посилання недійсне або застаріло. Запросіть нове',
    ru: 'Ссылка недействительна или устарела. Запросите новую',
    en: 'The link is invalid or has expired. Request a new one',
  },
  sync_running: {
    uk: 'Завантаження даних уже йде: дочекайтеся її завершення',
    ru: 'Загрузка данных уже идёт: дождитесь её завершения',
    en: 'A data load is already running: wait for it to finish',
  },
  terms_not_accepted: {
    uk: 'Спочатку прийміть угоду про обробку даних (вікно в кабінеті)',
    ru: 'Сначала примите соглашение об обработке данных (окно в кабинете)',
    en: 'Accept the data processing agreement first (the dialog in the dashboard)',
  },
  terms_outdated: {
    uk: 'Текст угоди оновився: оновіть сторінку і прийміть поточну версію',
    ru: 'Текст соглашения обновился: обновите страницу и примите текущую версию',
    en: 'The agreement text was updated: reload the page and accept the current version',
  },
  email_not_verified: {
    uk: 'Спочатку підтвердьте пошту: перевірте лист із посиланням',
    ru: 'Сначала подтвердите почту: проверьте письмо со ссылкой',
    en: 'Confirm your email first: check the message with the link',
  },
  bad_work_hours: {
    uk: 'Перевірте робочі години: для кожного дня потрібен початок і кінець (початок раніше кінця) або вихідний',
    ru: 'Проверьте рабочие часы: для каждого дня нужны начало и конец (начало раньше конца) или выходной',
    en: 'Check the working hours: each day needs a start and an end (start before end) or a day off',
  },
  report_forbidden: {
    uk: 'Цей звіт недоступний для вашої ролі',
    ru: 'Этот отчёт недоступен для вашей роли',
    en: 'This report is not available for your role',
  },
  already_member: {
    uk: 'Співробітник уже в клініці',
    ru: 'Сотрудник уже в клинике',
    en: 'This employee is already in the clinic',
  },
};

@Catch(HttpException)
export class I18nExceptionFilter implements ExceptionFilter {
  catch(ex: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest();
    const res = ctx.getResponse();
    const status = ex.getStatus();
    const body = ex.getResponse();
    const payload: Record<string, unknown> =
      typeof body === 'string' ? { statusCode: status, message: body } : { ...(body as object) };
    // Стандартные английские тексты Nest и multer подменяем нашими ключами
    const standard: Record<string, string> = { 'File too large': 'file_too_big', 'Forbidden resource': 'forbidden', Unauthorized: 'unauthorized' };
    const key = typeof payload.message === 'string' && standard[payload.message] ? standard[payload.message] : payload.message;
    if (typeof key === 'string' && ERRORS[key]) {
      payload.message = ERRORS[key][langFromHeader(req.headers['accept-language'])];
    }
    res.status(status).json(payload);
  }
}

// ---------- отчёты ----------
export type ReportId =
  | 'no-next-visit'
  | 'missed-visits'
  | 'unclosed-visits'
  | 'lapsed-patients'
  | 'sources'
  | 'unfinished-treatment'
  | 'debtors'
  | 'revenue'
  | 'free-slots';

export const REPORT_TEXT: Record<ReportId, { title: Record<Lang, string>; daysLabel: Record<Lang, string> }> = {
  'no-next-visit': {
    title: { uk: 'Немає наступного запису після візиту', ru: 'Нет следующей записи после посещения', en: 'No next appointment after a visit' },
    daysLabel: { uk: 'Візит за останні, дн.', ru: 'Посещение за последние, дн.', en: 'Visit in the last, days' },
  },
  'missed-visits': {
    title: { uk: 'Неявки, скасування та перенесення', ru: 'Неявки, отмены и переносы', en: 'No-shows, cancellations and reschedules' },
    daysLabel: { uk: 'За останні, дн.', ru: 'За последние, дн.', en: 'In the last, days' },
  },
  'unclosed-visits': {
    title: { uk: 'Записи без підсумку', ru: 'Записи без итога', en: 'Appointments without an outcome' },
    daysLabel: { uk: 'За останні, дн.', ru: 'За последние, дн.', en: 'In the last, days' },
  },
  'lapsed-patients': {
    title: { uk: 'Пацієнти, які давно не були', ru: 'Давно не посещавшие пациенты', en: 'Patients who have not visited for a long time' },
    daysLabel: { uk: 'Не були понад, дн.', ru: 'Не были более, дн.', en: 'Not seen for more than, days' },
  },
  sources: {
    title: { uk: 'Джерела звернень', ru: 'Источники обращения', en: 'Referral sources' },
    daysLabel: { uk: 'Візити за останні, дн.', ru: 'Посещения за последние, дн.', en: 'Visits in the last, days' },
  },
  'unfinished-treatment': {
    title: { uk: 'Незавершене лікування', ru: 'Незавершённое лечение', en: 'Unfinished treatment' },
    daysLabel: { uk: 'Лікування розпочато за останні, дн.', ru: 'Лечение начато за последние, дн.', en: 'Treatment started in the last, days' },
  },
  debtors: {
    title: { uk: 'Заборгованість пацієнтів', ru: 'Задолженность пациентов', en: 'Patient balances due' },
    daysLabel: { uk: 'Період не застосовується', ru: 'Период не применяется', en: 'Period not applicable' },
  },
  revenue: {
    title: { uk: 'Виставлено і сплачено по місяцях', ru: 'Выставлено и оплачено по месяцам', en: 'Invoiced and paid by month' },
    daysLabel: { uk: 'Період, дн.', ru: 'Период, дн.', en: 'Period, days' },
  },
  'free-slots': {
    title: { uk: 'Вільні вікна лікарів', ru: 'Свободные окна врачей', en: 'Free doctor slots' },
    daysLabel: { uk: 'Найближчі, дн.', ru: 'Ближайшие, дн.', en: 'Next, days' },
  },
};

export const REPORT_RULE: Record<ReportId, Record<Lang, (d: number, max?: number) => string>> = {
  'no-next-visit': {
    uk: (d) => `Пацієнти з відбутим візитом (VISITED) за останні ${d} дн. і без майбутніх дійсних записів (CANCELLED, DID_NOT_COME, MOVED не враховуються). Пацієнти з активним нагадуванням (NEW) на сьогодні або пізніше не показуються: про них уже пам’ятають`,
    ru: (d) => `Пациенты с состоявшимся посещением (VISITED) за последние ${d} дн. и без будущих действующих записей (CANCELLED, DID_NOT_COME, MOVED не считаются). Пациенты с активным напоминанием (NEW) на сегодня или позже не показываются: о них уже помнят`,
    en: (d) => `Patients with a completed visit (VISITED) in the last ${d} days and no upcoming active appointment (CANCELLED, DID_NOT_COME and MOVED do not count). Patients with an active reminder (NEW) for today or later are not shown: someone is already following up`,
  },
  'missed-visits': {
    uk: (d) => `Записи зі статусом DID_NOT_COME, CANCELLED або MOVED за останні ${d} дн. Колонка «Записаний знову» показує, чи є в пацієнта майбутній дійсний запис`,
    ru: (d) => `Записи со статусом DID_NOT_COME, CANCELLED или MOVED за последние ${d} дн. Колонка «Записан снова» показывает, есть ли у пациента будущая действующая запись`,
    en: (d) => `Appointments with status DID_NOT_COME, CANCELLED or MOVED in the last ${d} days. The “Rebooked” column shows whether the patient has an upcoming active appointment`,
  },
  'unclosed-visits': {
    uk: (d) => `Записи за останні ${d} дн., час яких минув понад 2 години тому, але статус не змінено на підсумок (залишились «Запланований», «Підтверджений», «Не підтверджений», «У клініці», «У кріслі»). Невідомо, чи прийшов пацієнт: закрийте запис у Cliniccards (статус «Був на прийомі», «Не прийшов», «Скасований» або «Перенесений»). Тут нічого не змінюється автоматично`,
    ru: (d) => `Записи за последние ${d} дн., время которых прошло более 2 часов назад, но статус не заменён на итог (остались «Запланирован», «Подтверждён», «Не подтверждён», «В клинике», «В кресле»). Неизвестно, пришёл ли пациент: закройте запись в Cliniccards (статус «Был на приёме», «Не пришёл», «Отменён» или «Перенесён»). Здесь ничего не меняется автоматически`,
    en: (d) => `Appointments from the last ${d} days whose time ended more than 2 hours ago but whose status was never changed to an outcome (still Scheduled, Confirmed, Not confirmed, In clinic, In chair). It is unknown whether the patient came: close the appointment in Cliniccards (Visited, No-show, Cancelled or Rescheduled). Nothing is changed here automatically`,
  },
  'lapsed-patients': {
    uk: (d, max) => `Пацієнти, чий останній візит (за карткою Cliniccards) був від ${d} до ${max ?? 730} дн. тому і в яких немає майбутніх дійсних записів. Пацієнти без візитів не враховані. Пацієнти з активним нагадуванням (NEW) на сьогодні або пізніше не показуються: про них уже пам’ятають. Порядок: спершу ті, у кого є незавершене лікування (за сумою), потім за сумою оплат за весь час`,
    ru: (d, max) => `Пациенты, у которых последний визит (по карточке Cliniccards) был от ${d} до ${max ?? 730} дн. назад и нет будущих действующих записей. Пациенты без визитов не включены. Пациенты с активным напоминанием (NEW) на сегодня или позже не показываются: о них уже помнят. Порядок: сначала те, у кого есть незавершённое лечение (по сумме), затем по сумме оплат за всё время`,
    en: (d, max) => `Patients whose last visit (per the Cliniccards record) was between ${d} and ${max ?? 730} days ago and who have no upcoming active appointment. Patients without visits are excluded. Patients with an active reminder (NEW) for today or later are not shown: someone is already following up. Order: patients with unfinished treatment first (by amount), then by total paid over time`,
  },

  sources: {
    uk: (d) => `Усі пацієнти за полем «Джерело» в Cliniccards; «Були на прийомі» та «Візитів» — відбуті візити за останні ${d} дн.; «Сума послуг» — сума цін послуг цих візитів`,
    ru: (d) => `Все пациенты по полю «Источник» в Cliniccards; «Были на приёме» и «Визитов» — состоявшиеся посещения за последние ${d} дн.; «Сумма услуг» — сумма цен услуг этих визитов`,
    en: (d) => `All patients by the “Source” field in Cliniccards; “Attended” and “Visits” count completed visits in the last ${d} days; “Services total” is the sum of service prices of those visits`,
  },
  'unfinished-treatment': {
    uk: (d) => `Пацієнти, у яких лікування розпочате (за останні ${d} дн. виконано пункт плану), але в плані лишилися невиконані пункти (NEW, PLANNED_TO_DO), і немає майбутніх дійсних записів. Пацієнти з активним нагадуванням (NEW) на сьогодні або пізніше не показуються: про них уже пам’ятають`,
    ru: (d) => `Пациенты, у которых лечение начато (за последние ${d} дн. выполнен пункт плана), но в плане остались невыполненные пункты (NEW, PLANNED_TO_DO), и нет будущих действующих записей. Пациенты с активным напоминанием (NEW) на сегодня или позже не показываются: о них уже помнят`,
    en: (d) => `Patients whose treatment has started (a plan item was completed in the last ${d} days) but who still have unfinished plan items (NEW, PLANNED_TO_DO) and no upcoming active appointment. Patients with an active reminder (NEW) for today or later are not shown: someone is already following up`,
  },
  debtors: {
    uk: () => 'Пацієнти, у яких виставлено до оплати більше, ніж сплачено (за карткою Cliniccards: виставлено мінус сплачено)',
    ru: () => 'Пациенты, у которых выставлено к оплате больше, чем оплачено (по карточке Cliniccards: выставлено минус оплачено)',
    en: () => 'Patients billed for more than they have paid (per the Cliniccards record: billed minus paid)',
  },
  revenue: {
    uk: (d) => `По місяцях за останні ${d} дн.: «Виставлено» — сума актів виконаних робіт, «Сплачено» — сума платежів, «Платежів» — їх кількість`,
    ru: (d) => `По месяцам за последние ${d} дн.: «Выставлено» — сумма актов выполненных работ, «Оплачено» — сумма платежей, «Платежей» — их количество`,
    en: (d) => `By month for the last ${d} days: “Invoiced” is the sum of completed-work invoices, “Paid” is the sum of payments, “Payments” is their count`,
  },
  'free-slots': {
    uk: (d) => `Вільний час лікарів на найближчі ${d} дн.: зміна лікаря мінус його дійсні записи та зарезервований час кабінету. Показано проміжки від 30 хв`,
    ru: (d) => `Свободное время врачей на ближайшие ${d} дн.: смена врача минус его действующие записи и зарезервированное время кабинета. Показаны промежутки от 30 мин`,
    en: (d) => `Free doctor time for the next ${d} days: the doctor’s shift minus their active appointments and time reserved in the cabinet. Gaps of 30 minutes or more are shown`,
  },
};

export const COLUMN_LABEL: Record<Lang, Record<string, string>> = {
  uk: {
    fullName: 'Пацієнт', phone: 'Телефон', visitedAt: 'Візит', lastService: 'Послуга', lastDoctor: 'Лікар', daysSince: 'Днів минуло', visitTime: 'Час', visitStatus: 'Статус запису',
    visitAt: 'Дата запису', kind: 'Що сталося', doctor: 'Лікар', service: 'Послуга', rebooked: 'Записаний знову',
    lastVisitAt: 'Останній візит', source: 'Джерело', patients: 'Пацієнтів', active: 'Були на прийомі', visits: 'Візитів', revenue: 'Сума послуг',
    openItems: 'Не виконано послуг', openSum: 'Сума невиконаного', lifetimePaid: 'Оплачено всього', lastDoneAt: 'Останній виконаний', debt: 'Борг', balanceIssued: 'Виставлено',
    balancePaid: 'Сплачено', month: 'Місяць', invoiced: 'Виставлено', paid: 'Сплачено', paymentsCount: 'Платежів', dayAt: 'Дата', cabinet: 'Кабінет',
    freeMinutes: 'Вільно, хв', windows: 'Вільні проміжки',
  },
  ru: {
    fullName: 'Пациент', phone: 'Телефон', visitedAt: 'Посещение', lastService: 'Услуга', lastDoctor: 'Врач', daysSince: 'Дней прошло', visitTime: 'Время', visitStatus: 'Статус записи',
    visitAt: 'Дата записи', kind: 'Что случилось', doctor: 'Врач', service: 'Услуга', rebooked: 'Записан снова',
    lastVisitAt: 'Последний визит', source: 'Источник', patients: 'Пациентов', active: 'Были на приёме', visits: 'Визитов', revenue: 'Сумма услуг',
    openItems: 'Не выполнено услуг', openSum: 'Сумма невыполненного', lifetimePaid: 'Оплачено всего', lastDoneAt: 'Последний выполненный', debt: 'Долг', balanceIssued: 'Выставлено',
    balancePaid: 'Оплачено', month: 'Месяц', invoiced: 'Выставлено', paid: 'Оплачено', paymentsCount: 'Платежей', dayAt: 'Дата', cabinet: 'Кабинет',
    freeMinutes: 'Свободно, мин', windows: 'Свободные промежутки',
  },
  en: {
    fullName: 'Patient', phone: 'Phone', visitedAt: 'Visit', lastService: 'Service', lastDoctor: 'Doctor', daysSince: 'Days ago', visitTime: 'Time', visitStatus: 'Appointment status',
    visitAt: 'Appointment date', kind: 'What happened', doctor: 'Doctor', service: 'Service', rebooked: 'Rebooked',
    lastVisitAt: 'Last visit', source: 'Source', patients: 'Patients', active: 'Attended', visits: 'Visits', revenue: 'Services total',
    openItems: 'Unfinished services', openSum: 'Unfinished total', lifetimePaid: 'Paid in total', lastDoneAt: 'Last completed', debt: 'Debt', balanceIssued: 'Billed',
    balancePaid: 'Paid', month: 'Month', invoiced: 'Invoiced', paid: 'Paid', paymentsCount: 'Payments', dayAt: 'Date', cabinet: 'Cabinet',
    freeMinutes: 'Free, min', windows: 'Free gaps',
  },
};

// Подписи значений для CSV (в интерфейсе их показывает веб-клиент)
export const VALUE_LABEL: Record<Lang, { kind: Record<string, string>; status: Record<string, string>; yes: string; no: string; notSpecified: string }> = {
  uk: { kind: { DID_NOT_COME: 'Неявка', CANCELLED: 'Скасування', MOVED: 'Перенесення' }, status: { PLANNED: 'Запланований', CONFIRMED: 'Підтверджений', NOT_CONFIRMED: 'Не підтверджений', IN_CLINIC: 'У клініці', IN_CHAIR: 'У кріслі' }, yes: 'Так', no: 'Ні', notSpecified: 'Не вказано' },
  ru: { kind: { DID_NOT_COME: 'Неявка', CANCELLED: 'Отмена', MOVED: 'Перенос' }, status: { PLANNED: 'Запланирован', CONFIRMED: 'Подтверждён', NOT_CONFIRMED: 'Не подтверждён', IN_CLINIC: 'В клинике', IN_CHAIR: 'В кресле' }, yes: 'Да', no: 'Нет', notSpecified: 'Не указан' },
  en: { kind: { DID_NOT_COME: 'No-show', CANCELLED: 'Cancelled', MOVED: 'Rescheduled' }, status: { PLANNED: 'Scheduled', CONFIRMED: 'Confirmed', NOT_CONFIRMED: 'Not confirmed', IN_CLINIC: 'In clinic', IN_CHAIR: 'In chair' }, yes: 'Yes', no: 'No', notSpecified: 'Not specified' },
};

// Заголовки задач, создаваемых из отчётов (сохраняются на языке пользователя в момент создания)
export const TASK_TITLE: Record<string, Record<Lang, string>> = {
  'no-next-visit': {
    uk: 'Запросити на наступний візит',
    ru: 'Пригласить на следующий визит',
    en: 'Invite for the next visit',
  },
  'missed-visits': {
    uk: "Зв'язатися після неявки/скасування/перенесення",
    ru: 'Связаться после неявки/отмены/переноса',
    en: 'Follow up after a no-show / cancellation / reschedule',
  },
  'unclosed-visits': {
    uk: 'Закрити записи пацієнта в Cliniccards (виставити підсумок)',
    ru: 'Закрыть записи пациента в Cliniccards (выставить итог)',
    en: 'Close the patient’s appointments in Cliniccards (set the outcome)',
  },
  'lapsed-patients': {
    uk: 'Повернути пацієнта, який давно не був',
    ru: 'Вернуть давно не бывавшего пациента',
    en: 'Win back a patient who has not visited for a long time',
  },
  'unfinished-treatment': {
    uk: 'Запропонувати продовжити лікування',
    ru: 'Предложить продолжить лечение',
    en: 'Offer to continue treatment',
  },
  debtors: {
    uk: 'Нагадати про заборгованість',
    ru: 'Напомнить о задолженности',
    en: 'Remind about the balance due',
  },
};
