// Checking the settings at start. In production weak secrets and unsafe addresses mean a refusal to start,
// not silent work with a hole.
const WEAK = ['change-me', 'changeme', 'secret', 'password', 'test-jwt-secret', 'test-encryption-key'];

export function configProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const secret = (name: string) => {
    const v = env[name] ?? '';
    if (!v) problems.push(`${name} не задан`);
    else if (v.length < 32) problems.push(`${name} короче 32 символов`);
    else if (WEAK.some((w) => v.toLowerCase().includes(w))) problems.push(`${name} похож на значение по умолчанию`);
  };
  secret('JWT_SECRET');
  secret('ENCRYPTION_KEY');
  if (env.JWT_SECRET && env.JWT_SECRET === env.ENCRYPTION_KEY) problems.push('JWT_SECRET и ENCRYPTION_KEY должны быть разными');
  if (!env.DATABASE_URL) problems.push('DATABASE_URL не задан');
  if (!env.WEB_ORIGIN) problems.push('WEB_ORIGIN не задан');
  else if (!env.WEB_ORIGIN.startsWith('https://')) problems.push('WEB_ORIGIN должен быть адресом с https://');
  if (!env.RESEND_API_KEY && !env.SMTP_URL) problems.push('Не задан ни RESEND_API_KEY, ни SMTP_URL: без почты не работают сброс пароля и подтверждение адреса');
  if (env.RESEND_API_KEY && !(env.EMAIL_FROM ?? env.MAIL_FROM)) problems.push('EMAIL_FROM не задан: укажите отправителя, например LANKA <notifications@lankaclinic.app>');
  // The development database password is public (it is in the repository): a production database must have its own
  if (/^postgres(ql)?:\/\/stomat:stomat@/.test(env.DATABASE_URL ?? '')) problems.push('DATABASE_URL использует пароль разработки (stomat:stomat): задайте свой пароль базы');
  // Switches that exist for development and tests only
  if (env.REQUIRE_EMAIL_VERIFICATION === 'false') problems.push('REQUIRE_EMAIL_VERIFICATION=false допустим только в разработке');
  if (Number(env.RATE_LIMIT_IP_MULTIPLIER ?? 1) > 1) problems.push('RATE_LIMIT_IP_MULTIPLIER больше 1 допустим только в тестах: лимиты попыток по адресу ослаблены');
  // Meta: a secret without the verify token (or the other way round) leaves the webhooks deaf; the login needs all three values
  if ((env.META_APP_SECRET || env.META_INSTAGRAM_APP_SECRET) && !env.META_VERIFY_TOKEN) problems.push('META_VERIFY_TOKEN не задан: Meta не сможет подтвердить адрес вебхуков');
  if (env.META_CONFIG_ID && !(env.META_APP_ID && env.META_APP_SECRET)) problems.push('META_CONFIG_ID задан без META_APP_ID и META_APP_SECRET: вход через Facebook не заработает');
  return problems;
}

export function assertConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const problems = configProblems(env);
  if (problems.length) throw new Error('Небезопасные настройки сервера, запуск остановлен:\n - ' + problems.join('\n - '));
}
