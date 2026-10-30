import type { Metadata } from 'next';
import type { Locale } from './i18n';

// The public address of the site: canonical links, the sitemap, hreflang and structured data are built from it
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://app.lankaclinic.app').replace(/\/$/, '');

// One address per language: crawlers need a separate URL for every language version
export const LANDING_PATH: Record<Locale, string> = { uk: '/', ru: '/ru', en: '/en' };

const OG_LOCALE: Record<Locale, string> = { uk: 'uk_UA', ru: 'ru_UA', en: 'en_US' };

// Only what really works is named here (see the integration flags in landing-text.ts)
const TEXT: Record<Locale, { title: string; description: string; imageAlt: string }> = {
  uk: {
    title: 'LANKA: звіти та ШІ-адміністратор для клінік на Cliniccards',
    description: 'Звіти з Excel і PDF, відповіді ШІ пацієнтам у месенджерах, нагадування та воронка пацієнта для клінік на Cliniccards. Демо без реєстрації.',
    imageAlt: 'LANKA: звіти, ШІ-адміністратор і автоматизація для клінік на Cliniccards',
  },
  ru: {
    title: 'LANKA: отчёты и ИИ-администратор для клиник на Cliniccards',
    description: 'Отчёты в Excel и PDF, ответы ИИ пациентам в мессенджерах, напоминания и воронка пациента для клиник на Cliniccards. Демо без регистрации.',
    imageAlt: 'LANKA: отчёты, ИИ-администратор и автоматизация для клиник на Cliniccards',
  },
  en: {
    title: 'LANKA: reports and AI front desk for Cliniccards clinics',
    description: 'Excel and PDF reports, AI replies to patients in messengers, reminders and a patient funnel for clinics on Cliniccards. Demo, no sign-up.',
    imageAlt: 'LANKA: reports, AI front desk and automation for clinics on Cliniccards',
  },
};

export function landingMetadata(lang: Locale): Metadata {
  const x = TEXT[lang];
  const image = { url: `/og/og-${lang}.png`, width: 1200, height: 630, alt: x.imageAlt };
  return {
    title: { absolute: x.title },
    description: x.description,
    alternates: {
      canonical: LANDING_PATH[lang],
      languages: { uk: LANDING_PATH.uk, ru: LANDING_PATH.ru, en: LANDING_PATH.en, 'x-default': LANDING_PATH.uk },
    },
    openGraph: {
      type: 'website',
      siteName: 'LANKA',
      title: x.title,
      description: x.description,
      url: LANDING_PATH[lang],
      locale: OG_LOCALE[lang],
      alternateLocale: (Object.keys(OG_LOCALE) as Locale[]).filter((l) => l !== lang).map((l) => OG_LOCALE[l]),
      images: [image],
    },
    twitter: { card: 'summary_large_image', title: x.title, description: x.description, images: [image.url] },
  };
}
