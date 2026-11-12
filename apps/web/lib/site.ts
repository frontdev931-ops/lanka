import type { Metadata } from 'next';
import type { Locale } from './i18n';

// The public address of the site: canonical links, the sitemap, hreflang and structured data are built from it
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://app.lankaclinic.app').replace(/\/$/, '');

// One address per language: crawlers need a separate URL for every language version
export const LANDING_PATH: Record<Locale, string> = { uk: '/', ru: '/ru', en: '/en' };

const OG_LOCALE: Record<Locale, string> = { uk: 'uk_UA', ru: 'ru_UA', en: 'en_US' };

// The same positioning as the visible page (lib/landing-text.ts): no measured results, only what the product does
const TEXT: Record<Locale, { title: string; description: string; imageAlt: string }> = {
  uk: {
    title: 'LANKA: більше повторних візитів і менше ручної роботи для клінік на Cliniccards',
    description: 'Пацієнти без наступного запису, звернення з Telegram та Instagram з допомогою ШІ, звіти в Excel і PDF без ручних таблиць. Працює разом із Cliniccards. Демо без реєстрації.',
    imageAlt: 'LANKA: звіти, ШІ-адміністратор і автоматизація для клінік на Cliniccards',
  },
  ru: {
    title: 'LANKA: больше повторных визитов и меньше ручной работы для клиник на Cliniccards',
    description: 'Пациенты без следующей записи, обращения из Telegram и Instagram с помощью ИИ, отчёты в Excel и PDF без ручных таблиц. Работает вместе с Cliniccards. Демо без регистрации.',
    imageAlt: 'LANKA: отчёты, ИИ-администратор и автоматизация для клиник на Cliniccards',
  },
  en: {
    title: 'LANKA: more repeat visits and less manual work for Cliniccards clinics',
    description: 'Patients without a next appointment, Telegram and Instagram inquiries with AI help, Excel and PDF reports without manual spreadsheets. Works alongside Cliniccards. Demo, no sign-up.',
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
