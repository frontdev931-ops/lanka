'use client';

import { LOCALES, Locale, useI18n } from '../lib/i18n';

export default function LanguageSwitcher({ compact }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className={`lang${compact ? ' compact' : ''}`} role="group" aria-label={t('common.language')}>
      {LOCALES.map((l) => (
        <button
          key={l.code}
          type="button"
          className={`lang-btn${locale === l.code ? ' active' : ''}`}
          onClick={() => setLocale(l.code as Locale)}
          title={l.label}
          aria-pressed={locale === l.code}
        >
          {l.code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
