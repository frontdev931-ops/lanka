# LANKA (working folder name: stomat): a web app for dental clinics on Cliniccards

Full project documentation lives in `.claude/docs/`. Read it before working on the matching area. Documentation, code comments, commit messages and internal notes are written in **English**; the product UI is Ukrainian (default), Russian and English.

## What this is
A clinic workspace on top of Cliniccards (which stays the main system for patients, treatment and the schedule):
- reports (9 ready reports, a report builder with Excel/PDF export, an AI assistant for the manager);
- patient funnel analytics, inquiries journal, tasks;
- messaging: Telegram bot with reminders and scenarios, campaigns, chat inbox, AI-drafted or automatic replies, booking requests for the administrator, staff chat, manager digest, visit ratings;
- team, roles, audit, two-factor sign-in; installable on a phone as a PWA.
Current state, decisions and the backlog: `.claude/docs/plan.md`.

## Structure
- `apps/api`: NestJS 11 + Prisma 6 + PostgreSQL 16 (port 3001)
- `apps/web`: Next.js 15 (App Router, port 3000)
- `docs/`: documents for the owner and the clinic (hosting and security, personal data policy, patient funnel, messaging). `docs/01-questions-for-clinic.md` is the questionnaire for the clinic and stays in Russian on purpose.
- `.claude/docs/`: plan, architecture, conventions, security, Cliniccards API notes

## Run (Node 22: `nvm use`)
1. `npm install`
2. `npm run db:up` (PostgreSQL in Docker)
3. `cd apps/api && cp .env.example .env` (set `JWT_SECRET` and `ENCRYPTION_KEY`), then `npx prisma migrate dev`
4. `npm run dev:api` and `npm run dev:web`

## Sign-in and addresses
The browser talks only to the site address: `/backend/*` is proxied by Next to the API (`apps/web/next.config.mjs`, variable `API_URL`, default http://localhost:3001). The session is an httpOnly cookie `stomat_session` (SameSite=Lax, Secure in production); no token is kept in localStorage. External clients and tests may send `Authorization: Bearer`. For cookie requests the server compares the `Origin` header with `WEB_ORIGIN` (protection against forged requests). Staff are added only by an invitation link (`/team/invitations`, `/invite/<token>`); a password is never passed through the owner. Optional TOTP two-factor sign-in is configured in Settings.

## Mobile and PWA (mandatory)
Every new page must work at 390 px: no horizontal page scroll, inputs 16 px or larger, buttons 44 px or larger. `table.table` turns into cards on a phone (`Shell.tsx` fills in the column labels), so every table column needs text in its `<th>`. The bottom bar (`.tabbar`) holds the main sections and "More". Wide data (a file sample) goes into `.table-wrap` or `.sample-table` with scrolling. Check in a browser at 390 px. The app is an installable PWA (`app/manifest.ts`, `public/sw.js`, `public/offline.html`); the service worker never caches patient data or API responses (only the offline page, icons and hashed build files). Use `useConfirm()` for confirmations, never `window.confirm`.

## Tests
`cd apps/api && npm test` (needs a running Postgres). They run on a separate database `stomat_test`; create it once: `docker compose exec postgres createdb -U stomat stomat_test`, then `npm run test:prepare`. Repeat `npm run test:prepare` after every migration. Tests cover clinic isolation, roles, tasks, reports, encryption, the Cliniccards whitelist, messaging, AI guardrails, the report builder and two-factor sign-in; add an isolation check for every new endpoint with clinic data. Tests never call real external services (Telegram, Instagram, Messenger, WhatsApp, Viber, LiqPay, the mail provider and the AI client are faked or switched off in `test/env.ts`). Run the whole suite with `npm test` (one file at a time): the files share one database and the message queue of one file would pick up the messages of another when they run in parallel. A run on the real AI model: `RUN_AI_EVAL=1 npx jest test/ai-eval.spec.ts` (needs `AI_API_KEY` in `.env`, costs a few cents).

## Cliniccards mock (working without access to a clinic)
`cd apps/api && npm run mock:cliniccards` starts a local "Cliniccards" at http://127.0.0.1:4010/api (450 patients, visits, treatment plans, payments, invoices, shifts; key `mock-api-key-12345`). To make the API use it, start it like this: `CLINICCARDS_BASE_URL=http://127.0.0.1:4010/api CLINICCARDS_MIN_INTERVAL_MS=0 npm run dev:api`, then enter the key on the "Інтеграції" page. Replacing the address works only outside production. The mock follows the API documentation, not real responses: after the first real key, compare the fields (see `.claude/docs/cliniccards-api.md`). When you start test servers next to the working ones, use other ports and stop only your own processes; build a test copy of the web app with `NEXT_DIST_DIR=.next-qa` so it does not disturb the running dev server.

## API environment variables
`DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `WEB_ORIGIN`, `PORT`, `AUTO_SYNC_MINUTES` (auto-sync, default 60, 0 turns it off), `RESEND_API_KEY` and `EMAIL_FROM` (mail through Resend: password reset, verification, billing notices; `SMTP_URL` is the fallback; with neither, mails go to the server log, and in production the server refuses to start). Send a test mail: `cd apps/api && npx ts-node scripts/send-test-mail.ts you@example.com`, `AI_API_KEY` and `AI_MODEL` (one service-wide key for the AI features, default model `claude-haiku-5-5`), `AUTOMATIONS_TICK_SECONDS` (messaging scheduler, default 60), `PLATFORM_ADMIN_EMAILS` (comma-separated emails of the service owner; gives access to the `/platform` overview), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (phone push notifications; generate the keys once with `npm run vapid` in `apps/api`). For development and tests only: `CLINICCARDS_BASE_URL`, `CLINICCARDS_MIN_INTERVAL_MS`, `REQUIRE_EMAIL_VERIFICATION=false`, `RATE_LIMIT_IP_MULTIPLIER`, `TELEGRAM_POLL=false`. Hosting, production variables, backups and the checklist: `docs/02-hosting-and-security.md`. `CLINICCARDS_WRITE_ENABLED=true` is reserved for the unfinished write-back and must stay unset.

## Hard rules
- Every table with clinic data has `clinicId`; every query filters by the `clinicId` from the JWT, never from request parameters.
- External systems are connected only through the `ClinicConnector` interface (`apps/api/src/integrations/connector.ts`). The rest of the code does not know about Cliniccards directly. We do not write to Cliniccards.
- Report calculations are done by code, not by AI. AI only builds a request (a report spec) and explains aggregated results.
- A report always shows its rule and the data update date.
- Actions with consequences (messages to patients, changes to appointments) go through staff approval until the clinic turns on autonomy. The master sending switch is off by default.
- Do not log or send patient personal data to external services without an explicit decision (see `.claude/docs/security.md`). Never put patient names or phones into AI prompts.
- Product UI strings are trilingual through `lib/i18n.tsx`; documentation, comments and internal notes are English.
- Secrets live only in `.env`, which is not committed.
- There is no git repository yet; copy files aside before bulk edits and never open a file for writing before reading it.
