import type { MetadataRoute } from 'next';
import { SITE_URL } from '../lib/site';

// The cabinet sections are never linked from the public pages; they are listed here so that crawlers skip them.
// The sign-in and demo pages stay crawlable but carry noindex (see their layout.tsx).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/backend/', '/dashboard', '/patients', '/reports', '/settings', '/tasks', '/inbox', '/analytics', '/assistant', '/automations',
          '/billing', '/imports', '/inquiries', '/insights', '/integrations', '/knowledge', '/my-automations', '/platform', '/quality', '/waitlist',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
