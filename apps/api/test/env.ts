// Tests run on a separate database stomat_test (created once, see npm run test:prepare), the working database is not touched.
// A small pool per test app: many spec files in one run must not exhaust the PostgreSQL connection limit
process.env.DATABASE_URL = 'postgresql://stomat:stomat@localhost:5432/stomat_test?connection_limit=4';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key';
process.env.AUTO_SYNC_MINUTES = '0';
// Mailings and Telegram polling do not start by themselves in tests: tests call the needed steps directly
process.env.AUTOMATIONS_TICK_SECONDS = '0';
process.env.TELEGRAM_POLL = 'false';
// In tests email does not need confirming, except in the separate confirmation test (it turns the check on itself)
process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
// Limits by address are widened in tests (all requests come from one address); limits by email are ordinary
process.env.RATE_LIMIT_IP_MULTIPLIER = '10000';
// Tests go to the Cliniccards imitation with no pauses between requests
process.env.CLINICCARDS_MIN_INTERVAL_MS = '0';
// Tests never use real services: the mail key from the development .env must not be used (an empty value is not replaced by the .env file)
process.env.RESEND_API_KEY = '';
process.env.SMTP_URL = '';
