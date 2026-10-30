# SEO of the public site

## Structure
- One address per language: `/` (Ukrainian, main), `/ru`, `/en`. All three render `components/Landing.tsx` with a `lang` prop, so the server-rendered HTML is already in the right language. The language switcher on the landing is made of real links.
- `middleware.ts` puts the language of the address into the `x-lang` header; `app/layout.tsx` reads it for `<html lang>`. Because of that the pages are rendered on demand, not prerendered.
- `lib/site.ts`: `SITE_URL` (variable `NEXT_PUBLIC_SITE_URL`, default `https://app.lankaclinic.app`), page titles and descriptions per language, canonical, hreflang (`uk`, `ru`, `en`, `x-default`), Open Graph and Twitter cards.
- `components/LandingJsonLd.tsx`: JSON-LD (Organization, WebSite, SoftwareApplication with the UAH prices, FAQPage), built from `lib/landing-text.ts`, so the markup never says more than the page.
- `app/robots.ts`, `app/sitemap.ts` (with language alternates), preview images `public/og/og-{uk,ru,en}.png` (1200x630, drawn once with Pillow).
- `/login`, `/demo`, `/forgot`, `/reset`, `/verify`, `/invite` are `noindex` through their `layout.tsx`; the cabinet sections are listed in `robots.ts`. A new public page must be added to the sitemap; a new cabinet section to `robots.ts`.

## Rules
- Landing text and prices change in `lib/landing-text.ts` (and `apps/api/src/service/plans.ts`); metadata texts in `lib/site.ts` name only what really works.
- No rating or review markup until there are real reviews.

## Owner's steps (after deploy)
1. Google Search Console and Bing Webmaster Tools: add the domain, verify it (DNS record at Vercel), submit `https://app.lankaclinic.app/sitemap.xml`, request indexing of `/`, `/ru`, `/en`.
2. Check the preview with the Facebook Sharing Debugger and by pasting the link into Telegram.
3. Later: move the marketing site to the apex `lankaclinic.app` and keep the cabinet on `app.` (the apex now redirects to `app.`, so the brand domain carries no content). This needs separate origins for the site and the cabinet and is a separate task.
4. Real reviews, case studies and a blog are what moves rankings after the technical base.
