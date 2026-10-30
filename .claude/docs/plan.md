# Plan and status

## Idea
A web app for dental clinics on Cliniccards: reports without manual copying, an AI assistant over the data, automation of repeat contact, a workspace for the administrator, and results for the owner. Cliniccards stays the system of record (patients, treatment, schedule); we only read from it.

## Modules and status (2026-10-29)
| Module | Status |
|---|---|
| Home, patients (search, card, contact history, consent, pause) | done |
| Reports: 9 ready reports + CSV/Excel/PDF; report builder; saved reports | done |
| Analytics: patient funnel, inquiries journal, message results | done |
| Tasks for the administrator (inside the app) | done, but unused by the first clinic; not developed further |
| Import from Excel/CSV | done |
| Integrations: Cliniccards (read only), Telegram bot | done |
| Automations: scenarios, approval queue, log, campaigns, manager mode switch | done; not verified on a live bot |
| Chat inbox ("Листування"): replies, AI drafts, auto-replies, booking requests, staff chat | done; not verified on a live bot |
| AI assistant for the manager ("ШІ-помічник") | done |
| Manager digest in Telegram | done; not verified on a live bot |
| Reviews and quality (ratings collected by the bot) | done; not verified on a live bot |
| Security: roles, audit, TOTP two-factor sign-in, terms acceptance | done |
| PWA (installable app) | done |
| "Booking" page | removed on purpose: booking stays in Cliniccards |
| Service management: plans and limits with a usage page, platform-owner overview and suspension, in-app clinic switcher, mandatory 2FA switch, staff management | done |
| Billing and payments | built on fakes (stage 1): plans, LiqPay checkout and signed callback, setup fee, AI reply allowance and packs, access lock before payment; **not verified with real LiqPay keys** |
| Phone notifications for staff (web push over the PWA) | done; needs VAPID keys on the server |
| Messenger, WhatsApp, Viber, website chat | built on fakes (stage 5); WhatsApp templates not built; Viber has no partner; **not verified live** |
| Instagram + AI | built and tested on fakes (webhook, inbox, AI replies with buttons, 24-hour window); **not verified live** (needs a public https address and Meta app review) |
| SMS fallback channel | not planned for now (decision 2026-10-29) |
| Writing appointments back to Cliniccards | built and tested on the mock (create, reschedule, cancel, confirm, new patient without duplicates); **off for all clinics, never run against a real clinic** |

## Decisions of the project owner
- Maximum automation: staff should enter almost nothing by hand (ratings, inquiries and requests arrive through the bot).
- No page that duplicates Cliniccards. The AI prepares a booking request; the administrator enters the appointment in Cliniccards (writing from our side is off and the AI setting "create appointments itself" is locked).
- Telegram first, then Instagram; SMS later; Viber/WhatsApp not planned. A bot can write only to people who pressed Start, so coverage grows through QR codes and links; this is a platform limit, not a bug.
- Consent: all patients of the first clinic sign the standard consent. The owner confirms it in settings (`Clinic.assumeConsent`, written to the audit log); `WITHDRAWN` always blocks. Check that the paper consent explicitly covers promotional messages in messengers.
- The manager digest and the staff chat are bound by a link or a code, never by a phone number (Telegram cannot find a person by number).
- One service-wide AI key in the server environment; clinics only switch features on and have a monthly limit. Terms of service name the AI provider and Telegram as subcontractors (`TERMS_VERSION` 2026-10-29).
- Reports are computed by code; the AI builds a report spec or explains aggregated numbers; rows with patients never go to the model.
- Cliniccards cannot tell administrators apart (all appointments are created by one shared profile), so a funnel slice by administrator is possible only from our own data (who handled a request, who logged an inquiry).
- First clinic (112 dental) currently reminds patients by hand (calls and messages), so duplication is possible with those manual reminders: agree with the owner when to switch the reminder scenario on.
- Documentation, comments and internal notes are in English; the product UI is Ukrainian/Russian/English.

## What exists (by area)
- **Service management** (`apps/api/src/service/`, `team/`): plans TRIAL/START/PRO/CUSTOM with limits (staff, messages per month, AI replies per month) and per-clinic overrides; the usage card in Settings; the platform-owner page `/platform` (people listed in `PLATFORM_ADMIN_EMAILS`) to see all clinics, change plans and limits, and suspend a clinic (staff are locked out, messaging and automations stop, data is kept); the owner can require two-factor sign-in from all staff and reset a member's second factor; role change and removal of staff; switching between clinics inside the app. Plan prices and billing are not defined.
- **Foundation:** multi-tenant data, sign-in with an httpOnly cookie, invitations by link, roles, audit log, rate limits in the database, email verification and password reset, optional TOTP two-factor sign-in (8 one-time recovery codes), terms click-wrap, production config validation, security headers, Docker, CI, backups (`docs/02-hosting-and-security.md`).
- **Cliniccards:** read-only connector with a GET whitelist, sync of patients, visits (3 years), plan items, payments, invoices, shifts and blocks, cabinets, plans, reminders, logo and birth dates; hourly auto-sync; a mock server for development.
- **Reports:** no next visit, no-shows/cancellations/reschedules, lapsed patients, unfinished treatment, debtors, sources, invoiced vs paid by month (managers only), free windows, visits without an outcome. Each shows its rule and the data update date. Export to CSV, Excel, PDF. The builder (`apps/api/src/report-builder/`) describes a report as a spec (dataset, columns, filters, grouping with totals, sorting); dates accept `2026-01-31` or `-30d`; money fields only for OWNER, MANAGER, ANALYST.
- **Funnel:** path to treatment, return, where we lose people (with lists), cohorts, sources and directions; inquiries journal (`apps/api/src/funnel/`, `docs/04-patient-funnel.md`).
- **Messaging** (`apps/api/src/automations/`, details in `docs/05-messaging-and-reminders.md`):
  - Telegram bot per clinic (token encrypted), deep links and QR, patient binding by link or shared contact, "Зупинити" opt-out.
  - Scenarios: visit reminder, no-show, repeat hygiene, thanks after a visit, continue treatment, lapsed, birthday, visit rating. Marketing needs consent and approval; at most one promotional message per patient in 14 days; sending window 08:00–22:00 Kyiv time; everything is re-checked right before sending.
  - Master switch `Clinic.sendingEnabled` (off by default) and a single "bot mode" choice on the Automations page: off, staff only, AI drafts, AI replies by itself.
  - Campaigns (custom promotion): audience filters, preview with reasons for exclusion, always through approval.
  - Chat inbox, AI draft button, auto-reply with guardrails, free-window suggestions as buttons, booking requests with a badge in the menu, staff chat bound by `/chat CODE`.
  - Manager digest (weekly or daily, to up to 5 recipients bound by a link, `/digest` command), visit ratings with a quality page, message results in the funnel page (booked within 14 days, replied within 7 days; correlation, not causation).
- **AI** (`apps/api/src/ai/`): one entry point `AiService.complete` (switch, monthly limit, usage without text); chat assistant with facts computed by code (last hygiene, free windows per cabinet or per doctor); owner assistant that builds report specs with up to 3 retries; guardrails in code. Real-model checks: `RUN_AI_EVAL=1 npx jest test/ai-eval.spec.ts` (14 chat dialogs plus owner questions).
- **PWA:** manifest, icons, installable on Android/iOS, offline page; the service worker caches only the shell and hashed build files, never API data.
- **Tests:** about 235 automated tests (isolation, roles, security, messaging, AI with fakes, report builder, two-factor); tests never call external services.

## Launch plan (approved 2026-10-29)
Full plan: stages 0-8 in `~/.claude/plans/virtual-hatching-karp.md` (commercial core, demo and site, Cliniccards write on the mock only, AI knowledge base, channels and web chat, automation builder, integrations, launch). Stage 0 (durable inbox, channel adapters) is done. Stage 6 has started (done: scheduled reports mailed as files, alerts for the manager, neutral review invitation, approval of the knowledge base by group; waiting list, automation builder, lead intake (site forms and Meta Lead Ads). Stage 6 is complete on fakes. Connecting Facebook and Instagram with Facebook Login for Business is built on fakes (not verified with the real configuration); WhatsApp Embedded Signup is the next separate task): the review invitation is now neutral (the same link goes to every rating, a low rating also starts the private complaint flow) and drafts of the knowledge base can be approved by price-list group; the automation builder, waiting list, scheduled reports, alerts and lead sources are still to do. Stage 5 (channels and the web chat) is built on fakes: Messenger, WhatsApp (inbound, replies in the 24-hour window, no templates yet), Viber behind an interface with no partner, the website widget, and the Instagram sign-in button added by Cursor (tested). Nothing is verified live. Stage 4 (clinic knowledge base for the AI, `apps/api/src/kb/`, page "Знання клініки") is done: only approved entries reach the model, prices only while confirmed within 90 days; the AI evals on the real model were not rerun yet (`RUN_AI_EVAL=1`). Stage 3 (writing visits and patients to Cliniccards, `apps/api/src/booking/`) is done and tested only against the mock; it is off for every clinic and the live check is a separate manual stage with the owner. Stage 2 (demo clinic copies and the public landing page) is done; the landing page has not been looked at in a browser yet. Stage 1 (billing and AI allowances) is done on fakes: the real LiqPay keys and the NBU rate call are still to be checked. The domain is `lankaclinic.app` (bought at Vercel). Hard limit: nothing is created or changed in the real 112 dental Cliniccards until a separate manual stage with the owner.

## Backlog (not done)
1. Live verification with a real bot: reminders, auto-reply, buttons, staff chat, digest, ratings, confirm buttons; then the first controlled sends.
2. Billing: a payment provider, prices per plan, invoices; AI cost per clinic in money terms.
3. Instagram live check: register the Meta app, set `META_APP_SECRET` and `META_VERIFY_TOKEN`, point the webhook to `{WEB_ORIGIN}/backend/instagram/webhook`, pass app review, test with the clinic account. Code is done (see `docs/05-messaging-and-reminders.md`).
4. Writing to Cliniccards (appointments, tasks): verify the `status` value for a new appointment, whether `doctor_id` is required and what the response contains; then connect to the locked AI setting. Needs explicit permission.
5. SMS fallback: not planned for now.
7. Before deploy (VAPID keys for push, `PLATFORM_ADMIN_EMAILS`, plus): hosting, domain and HTTPS, real SMTP, backups and monitoring, `git init`, Next 16 upgrade (2 audit findings), a lawyer reads the terms and the policy, replace Russian code comments with English ones over time.
6. Smaller: joins between datasets in the report builder, website leads (needs the form plugin name), PBX/telephony, merged or deleted patient handling in Cliniccards (hidden today, not merged), a doctor sees all patients (without money), a link to the patient card in Cliniccards (needs a sample address).

## Principles from the critical review
- Check first what the Cliniccards API gives; recording, tasks and scenarios depend on it.
- Multi-tenancy, consent and storage are the foundation, not an afterthought.
- Do not promise "any report" before the data sources are verified.
- Patient-facing AI replies stay behind approval until the clinic turns autonomy on.
- The source of every field is decided in advance so that sync does not overwrite data from spreadsheets.
