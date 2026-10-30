import { LANDING } from '../lib/landing-text';
import type { Locale } from '../lib/i18n';
import { LANDING_PATH, SITE_URL } from '../lib/site';

const EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? 'hello@lankaclinic.app';

// Structured data for search engines: the organization, the site, the product with its prices and the FAQ.
// Everything comes from the same text as the visible page, so the markup never says more than the page does.
export default function LandingJsonLd({ lang }: { lang: Locale }) {
  const L = LANDING[lang];
  const url = SITE_URL + LANDING_PATH[lang];
  const graph = [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: 'LANKA',
      url: SITE_URL,
      logo: `${SITE_URL}/logo.png`,
      email: EMAIL,
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'LANKA',
      inLanguage: lang,
      publisher: { '@id': `${SITE_URL}/#organization` },
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${url}#software`,
      name: 'LANKA',
      url,
      description: L.hero.sub,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      inLanguage: lang,
      publisher: { '@id': `${SITE_URL}/#organization` },
      offers: L.pricing.plans.map((p) => ({
        '@type': 'Offer',
        name: p.name,
        price: p.price.replace(/\D/g, ''),
        priceCurrency: 'UAH',
        url: `${url}#pricing`,
      })),
    },
    {
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      inLanguage: lang,
      mainEntity: L.faq.items.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    },
  ];
  // "<" is escaped so that no text inside the data can close the script tag
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
