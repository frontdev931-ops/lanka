import type { MetadataRoute } from 'next';
import { LANDING_PATH, SITE_URL } from '../lib/site';

// Public pages only. The three language versions of the landing point at each other.
export default function sitemap(): MetadataRoute.Sitemap {
  const languages = { uk: SITE_URL + LANDING_PATH.uk, ru: SITE_URL + LANDING_PATH.ru, en: SITE_URL + LANDING_PATH.en, 'x-default': SITE_URL + LANDING_PATH.uk };
  const lastModified = new Date();
  return [
    { url: SITE_URL + LANDING_PATH.uk, lastModified, changeFrequency: 'weekly', priority: 1, alternates: { languages } },
    { url: SITE_URL + LANDING_PATH.ru, lastModified, changeFrequency: 'weekly', priority: 0.9, alternates: { languages } },
    { url: SITE_URL + LANDING_PATH.en, lastModified, changeFrequency: 'weekly', priority: 0.9, alternates: { languages } },
    { url: `${SITE_URL}/terms`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE_URL}/privacy`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
