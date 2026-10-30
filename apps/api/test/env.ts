// Тесты идут на отдельной базе stomat_test (создаётся один раз, см. npm run test:prepare), рабочая база не затрагивается.
// A small pool per test app: many spec files in one run must not exhaust the PostgreSQL connection limit
process.env.DATABASE_URL = 'postgresql://stomat:stomat@localhost:5432/stomat_test?connection_limit=4';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key';
process.env.AUTO_SYNC_MINUTES = '0';
// Рассылки и опрос Telegram в тестах не запускаются сами: тесты вызывают нужные шаги напрямую
process.env.AUTOMATIONS_TICK_SECONDS = '0';
process.env.TELEGRAM_POLL = 'false';
// В тестах почту подтверждать не нужно, кроме отдельного теста подтверждения (он включает проверку сам)
process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
// Лимиты по адресу в тестах расширены (все запросы идут с одного адреса); лимиты по почте обычные
process.env.RATE_LIMIT_IP_MULTIPLIER = '10000';
// Тесты ходят в имитацию Cliniccards без пауз между запросами
process.env.CLINICCARDS_MIN_INTERVAL_MS = '0';
// Tests never use real services: the mail key from the development .env must not be used (an empty value is not replaced by the .env file)
process.env.RESEND_API_KEY = '';
process.env.SMTP_URL = '';
