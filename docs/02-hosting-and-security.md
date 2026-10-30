# Hosting and security

A document for whoever puts LANKA on a hosting provider. What is ready in the code, what has to be done by hand, and which decisions belong to the owner.

## Layout
- **Web** (`apps/web`, Next.js): Vercel or any Node host. The browser talks only to the site address; `/backend/*` is proxied to the API. The app is also an installable PWA (see below).
- **API** (`apps/api`, NestJS): Railway, Render, Fly or your own server. The image is built from `Dockerfile.api`.
- **Database:** PostgreSQL 16 (Railway Postgres or a cloud one). Region: Europe (Frankfurt or similar), the owner's decision, see the data policy.
- **Mail:** Resend (domain `lankaclinic.app` verified, region Ireland, sender `LANKA <notifications@lankaclinic.app>`); any SMTP also works as a fallback. Without mail, password reset and email verification do not work, so in production the server refuses to start without `RESEND_API_KEY` or `SMTP_URL`.
- The site and the API must be on **https** and at related addresses (the site `https://app.example.com`, the API reachable by the site at the private address `API_URL`).
- **Telegram webhook:** in production Telegram calls `{WEB_ORIGIN}/backend/telegram/webhook/<secret>`, so the site must be on a public https address (in development the bot is polled instead).

## Environment variables

| Where | Variable | Value |
|---|---|---|
| API | `NODE_ENV` | `production` |
| API | `DATABASE_URL` | PostgreSQL connection string |
| API | `JWT_SECRET` | a random string of 32+ characters (`openssl rand -base64 48`) |
| API | `ENCRYPTION_KEY` | another random string of 32+ characters; **losing the key makes stored Cliniccards keys and bot tokens unreadable** (they must be entered again) |
| API | `WEB_ORIGIN` | the site address, strictly `https://...` |
| API | `RESEND_API_KEY`, `EMAIL_FROM` | the Resend key (a separate key for the server only) and the sender `LANKA <notifications@lankaclinic.app>` |
| API | `SMTP_URL` | optional fallback, for example `smtps://user:password@smtp.example.com:465` |
| API | `PORT` | set by the host |
| API | `AUTO_SYNC_MINUTES` | 60 (0 turns auto-update off) |
| API | `AI_API_KEY` | the service-wide AI key (create it in the provider console, set a monthly spend limit there too); without it the AI features are unavailable |
| API | `AI_MODEL` | optional, default `claude-haiku-5-5` |
| API | `PLATFORM_ADMIN_EMAILS` | the service owner's email(s), comma-separated; they see all clinics and can change plans and suspend a clinic at `/platform` |
| API | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | phone push notifications for staff; generate the pair once with `npm run vapid` in `apps/api`; keep the private key secret |
| API | `META_APP_SECRET`, `META_VERIFY_TOKEN` | Instagram: the secret of the service's Meta app (checks the signature of every webhook) and a random string you also enter in the Meta webhook settings; without them Instagram messages are ignored |
| API | `LIQPAY_PUBLIC_KEY`, `LIQPAY_PRIVATE_KEY` | LiqPay merchant keys; without them online payment is off. The payment callback address is `https://lankaclinic.app/backend/billing/liqpay/callback` |
| API | `BILLING_ENFORCED`, `USD_UAH_RATE` | `BILLING_ENFORCED=false` turns the payment lock off (on by default in production); `USD_UAH_RATE` fixes the dollar rate instead of asking the National Bank |
| API | `META_APP_ID` | the Meta app id; with `META_APP_SECRET` it enables the "Connect Instagram" button (Instagram Business Login) |
| Web | `API_URL` | the API address as seen by the web server |

If a secret is weak, `JWT_SECRET` equals `ENCRYPTION_KEY`, the address is `http://`, or neither `RESEND_API_KEY` nor `SMTP_URL` is set, the API refuses to start and prints the reason. `CLINICCARDS_BASE_URL` is ignored in production. Leave `CLINICCARDS_WRITE_ENABLED` unset.

## First launch
1. Create the PostgreSQL database and save `DATABASE_URL`.
2. Deploy the API from `Dockerfile.api` (migrations run at start: `prisma migrate deploy`). Check: `GET /health` must return `{"ok":true}`.
3. Deploy the site with `API_URL`.
4. Register the owner and **confirm the email** from the message.
5. "Інтеграції" → the Cliniccards key. Data loading starts by itself.
6. Set the clinic working hours in "Налаштування"; optionally turn on two-factor sign-in for the owner.
7. "Автоматизації": connect the Telegram bot, the staff chat and the manager digest; leave the master switch "Off" until texts and queues are checked.
8. Turn on an availability check (for example UptimeRobot) on `https://<api>/health`.

## Instagram (Meta) setup, once for the whole service
1. Create a Meta developer app with the Instagram messaging product. Webhook address: `https://<site>/backend/instagram/webhook`, verify token = `META_VERIFY_TOKEN`; subscribe to `messages`.
2. Request advanced access for messaging and pass app review (needed before accounts other than your own testers can be used).
3. Each clinic's account must be a business account; its access token is pasted in "Автоматизації → Instagram".
4. Check live on the clinic account before switching AI replies on: a message arrives in the inbox, a reply goes out, the 24-hour rule holds.
**Connecting Facebook and Instagram (Facebook Login for Business).** The button "Підключити через Facebook" on the Automations page sends the owner to Facebook's dialog with our configuration (`config_id`, token kind "System-user access token", permissions for Pages and Instagram accounts). Facebook returns the person to `<site>/backend/meta/oauth/callback` with a code; the server exchanges it, reads which pages the person shared, lets them pick one, takes that page's token (stored encrypted), connects Messenger and the attached Instagram account and subscribes the page to the webhooks. Environment: `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`, `META_VERIFY_TOKEN`, `WEB_ORIGIN` (optionally `META_GRAPH_VERSION`). Permissions: each channel needs its own, none depends on another (`pages_messaging` for Messenger, `instagram_manage_messages` for Instagram, `leads_retrieval` for lead forms); a channel whose permission is not in the configuration is simply not connected. Token life: a system-user token does not expire, so there is no 60-day refresh; every 6 hours the server asks Meta whether each stored token is still valid and has an end date, marks the connection and writes once to the owner if it was revoked or ends within 7 days. The older Instagram Login button (60-day token with refresh) stays only for an app that has the separate Instagram app id and secret (`META_INSTAGRAM_APP_ID`, `META_INSTAGRAM_APP_SECRET`); new Meta apps cannot use it.
Addresses to enter in the Meta app settings (`<site>` is the public https address of the site; the site forwards `/backend/*` to the API):
- Facebook Login for Business "Valid OAuth Redirect URIs": `<site>/backend/meta/oauth/callback`. (The older Instagram Login address `<site>/backend/instagram/oauth/callback` is needed only with the Instagram app id.)
- "Deauthorize Callback URL" (Meta app: Settings > Advanced, or the Facebook Login settings): `<site>/backend/meta/deauthorize` (POST, signed_request).
- "Data Deletion Request URL": `<site>/backend/meta/data-deletion` (POST, signed_request; it answers with a confirmation code and the page `<site>/data-deletion?code=...`).
- "Privacy Policy URL": `<site>/privacy`; "Terms of Service URL": `<site>/terms`; "User data deletion" instructions may point to `<site>/privacy`.
- A separate Instagram app id and secret (if the dashboard shows them under Instagram > API setup) go to `META_INSTAGRAM_APP_ID` and `META_INSTAGRAM_APP_SECRET`; webhook and deletion signatures are accepted with either secret.
Webhook addresses in the Meta app: Instagram `https://<site>/backend/instagram/webhook` (field `messages`), Messenger `https://<site>/backend/messenger/webhook` (object Page, field `messages`), WhatsApp `https://<site>/backend/whatsapp/webhook` (field `messages`); the same verify token and app secret for all. Instagram sign-in redirect address: `https://<site>/backend/instagram/oauth/callback`.
The code was tested only on fakes: field names in webhooks and the send call must be compared with a real event.

## Before a commit (checked by hand, git is not run by the assistant)
- `.gitignore` keeps out: every `.env*` file except `.env.example`, `*.pem`/`*.key`, build output (`dist`, `.next`, `.next-qa`, `*.tsbuildinfo`), logs, database dumps and `backups/`, editor files, and local copies `.bak-*`. Check the list of files before the first commit: `apps/api/.env` and `apps/web/.env.local` must not be there.
- The repository should be **private**: it holds policy drafts, the name of the first clinic and the internal documentation.
- `.env.example` files hold no real values; the only password in the repository is the public development database password `stomat:stomat` (docker-compose, CI, tests). The server refuses to start in production with it.
- The seed script (`prisma/seed.ts`) creates a user with a known password and refuses to run in production.
- Production start checks (`common/config.ts`): secrets of 32+ characters, different from each other; https address; a mail key and sender; no development database password; no development switches (`REQUIRE_EMAIL_VERIFICATION=false`, `RATE_LIMIT_IP_MULTIPLIER`); LiqPay keys while the payment lock is on; Meta values consistent.
- Keys that appeared in chats or screenshots are reissued before real use (the Cliniccards key was reissued on 2026-10-29); the development `.env` has weaker secrets than production needs and must not be reused there.

## Backups
- Turn on automatic backups at the database provider (daily, kept for at least 7 days): **mandatory before accepting real data**.
- Manual copy: `DATABASE_URL=... ./scripts/backup.sh` (needs `pg_dump`). Keeps the last 30.
- Restore: `DATABASE_URL=... ./scripts/restore.sh backups/lanka-....sql.gz` (asks for confirmation).
- Once a quarter, check that a copy really restores on an empty database.
- A copy contains patient data: store it closed, do not forward it, do not commit it (`backups/` is in `.gitignore`).

## PWA (installable app)
- `app/manifest.ts`, icons in `public/icons/`, the service worker `public/sw.js` and the offline page `public/offline.html`. The service worker is served with `Cache-Control: no-store` so updates reach users quickly (bump `VERSION` in `sw.js` when its logic changes).
- Privacy: the service worker never caches API responses or pages with data; it keeps only the offline page, icons and hashed build files. After sign-out nothing sensitive is left in the cache.
- Install: Android/Chrome offers an install button in the app menu; on iPhone use Safari → Share → Add to Home Screen. A secure (https) address is required.

## What is already done in code
- Clinic isolation: `clinicId` only from the token, leak tests for every endpoint.
- Sign-in: password of 10+ characters, bcrypt hash (cost 12), httpOnly cookie `SameSite=Lax`, `Secure` in production, `Origin` check for cookie actions. Optional TOTP two-factor sign-in with one-time recovery codes (secret encrypted, a code cannot be reused, attempts are rate limited).
- Attempt limits **in the database**: sign-in (by email and by address), registration, password reset requests, re-sending a mail, two-factor codes. They work across several servers.
- Password reset and email verification by a one-time link (a hash in the database; reset valid for 1 hour, verification for 3 days; a new link revokes old ones). The "forgot password" answer does not reveal whether the email exists. After a reset all earlier sessions are closed.
- The role and clinic membership are checked **on every request**: a dismissed employee loses access at once, a role change takes effect at once.
- Connecting clinic data (the Cliniccards key) is only for the owner with a verified email.
- The doctor does not see patient money (debt, invoiced, paid, visit amounts), the debtors/sources/revenue reports, the message log, the inbox or the report builder. The builder hides money fields from administrators.
- Audit log: sign-in (including recovery-code sign-in), connections, exports (including report downloads and the full export), password reset, working-hours change, messaging and AI settings, approvals, terms acceptance.
- CSV: values that look like Excel formulas (`=`, `@`, `+cmd`) are neutralised; Excel and PDF exports are written to the audit log.
- Cliniccards keys and the Telegram bot token are stored encrypted (AES-256-GCM). Requests to Cliniccards are read-only through an address whitelist.
- AI safeguards: one service key on the server, per-feature switches, a monthly limit per clinic, counters without message text, dangerous topics never reach the model, replies are checked in code, patient names and phones are not sent. Patient messages are sent only when the master sending switch is on.
- Security headers on the site and API (`CSP`, `X-Frame-Options`, `nosniff`, `HSTS` in production, `Referrer-Policy`, `Permissions-Policy`).
- Startup configuration check, `/health` for the host, a non-root image, migrations at start.

## Known limitations (resolve before expanding)
- **Dependencies (`npm audit --omit=dev`):** there were 16 findings, 2 remain, both from Next.js 15 (the CSS build tool `postcss`; not called on the server and it needs attacker data inside CSS, which we do not have). The fix is only to upgrade Next to 16: a separate task. Done: NestJS 10 → 11 (Express 5, closing the file upload and request parsing vulnerabilities), `multer` 2.5.0, `deepmerge-ts` 8, `uuid` 11 through `overrides` in the root `package.json`, `prisma` moved to regular dependencies (container-start migrations run on the pinned version). **NestJS 12 is not possible yet**: it ships only as ESM and the project is CommonJS. Update dependencies only with a clean install (`rm -rf node_modules package-lock.json && npm install`): `overrides` are not applied to an already installed tree.
- **The doctor sees all clinic patients** (without money). "Own" patients cannot be separated: in Cliniccards the first clinic often shows the profile ("DENTAL CLINIC -2 112") as the doctor of a visit, not a person.
- **Two-factor sign-in:** the owner can make it mandatory for all staff and can reset a member's second factor. If the owner loses the phone and the recovery codes, there is no self-service way back (a manual database fix by the service owner).
- **An Excel import can be undone** (contact notes are deleted, changed fields return to their old values); later edits to the same fields are lost by the undo.
- **A clinic export is assembled in memory** (switch to streaming for very large clinics).
- **Email is the only recovery channel:** whoever owns the mailbox can reset the password.
- The audit log does not record every view of a patient card.
- There is no git repository yet: initialise one before deploying.

## Checklist before accepting real data
- [ ] A hosting region is chosen and the decision is written into the data policy.
- [ ] Automatic database backups are on and a restore has been tested.
- [ ] All environment variables are set, `/health` answers, the site is on https.
- [ ] The owner's email is verified and mails arrive (including not in "Spam").
- [x] The old Cliniccards key that appeared in chats and screenshots has been reissued (done by the owner 2026-10-29).
- [ ] The clinic owner agrees to the connection and has read the data policy.
- [x] The clinic's paper on personal data permits passing data to services and contacting the patient (confirmed by the owner of 112 dental). Ask again for every new clinic. Also confirm that it explicitly covers promotional messages in messengers before using the "standard consent" setting.
- [x] Processing agreement: the terms accepted at registration (and a window for clinics created earlier); acceptance is recorded. The terms name Telegram and the AI provider as subcontractors (`TERMS_VERSION` 2026-10-29).
- [ ] A contract (data processing terms) with the AI provider.
- [ ] Written confirmation from Cliniccards support that integrations by a clinic API key are allowed (verbally: the API is public).
- [ ] A lawyer reads the terms (`terms.*`) and the short list of questions at the end of `docs/03-personal-data-policy.md`.
- [ ] An availability check and error alerting are on.
- [ ] The bot is verified on a live clinic with a small group before the master switch is turned on.
