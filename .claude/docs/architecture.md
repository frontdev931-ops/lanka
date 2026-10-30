# Architecture

## Stack
- Web: Next.js 15 (App Router), React 19, TypeScript. Installable as a PWA (`app/manifest.ts`, `public/sw.js`, `public/offline.html`).
- API: NestJS 11 (CommonJS), TypeScript. Prisma 6, PostgreSQL 16. Node 22.
- Background work: in-process timers (`AutomationScheduler`, Telegram polling in development, hourly auto-sync) and counters in PostgreSQL (`RateLimit`). Redis and a queue are not needed yet and are deferred on purpose.
- AI: Anthropic Messages API, only from the server, one service-wide key (`AI_API_KEY`), a monthly reply limit per clinic and a usage journal without message text.
- Hosting: not decided yet (see `docs/02-hosting-and-security.md`).

## Multi-tenancy
Every table with clinic data has `clinicId`; every query filters by the `clinicId` from the JWT, never from request parameters. The auth guard loads the role from the database on every request. Uniqueness for idempotent sync is `(clinicId, externalId)`.

## Authentication
- httpOnly session cookie (`stomat_session`, SameSite=Lax, Secure in production) behind the `/backend/*` proxy of Next; `Authorization: Bearer` for tests and external clients; an `Origin` check for cookie requests.
- Password of 10+ characters, rate limits by email and by IP kept in the database, email verification, password reset, optional TOTP two-factor sign-in with one-time recovery codes (`apps/api/src/auth/`).
- Roles: OWNER, MANAGER, ADMIN, DOCTOR, ANALYST. Money fields are visible only to OWNER, MANAGER and ANALYST (the report builder enforces it per field). `AuthGuard` + `@Roles(...)` + `@CurrentUser()` in `apps/api/src/common/auth.guard.ts`.
- Terms acceptance (`TERMS_VERSION`) is required before connecting clinic data.

## Integrations
- `ClinicConnector` (`apps/api/src/integrations/connector.ts`) is the only way to external systems. Implementations: `DemoConnector` and `CliniccardsConnector` over `CliniccardsClient`. The client reads through a whitelist of GET paths, queues requests (limit 60 per minute), and keeps the key out of errors.
- Writing to Cliniccards is **not enabled**: a draft exists (`CliniccardsClient.post` for `/visits` only, blocked unless `CLINICCARDS_WRITE_ENABLED=true`, and `createVisit` is not called anywhere). The AI setting "create appointments itself" stays locked until this is verified on a live clinic.
- The API key is stored encrypted (`common/crypto.ts`, `ENCRYPTION_KEY`).
- Sync: `SyncService` upserts by `(clinicId, externalId)`, writes `SyncRun` and an audit entry.
- Instagram: `InstagramApi` (Graph API, token in a header), `InstagramService` (signed webhook at `/instagram/webhook`, chats saved as `ChatMessage` with `channel='INSTAGRAM'` and a message-id for idempotency). `MessengerService` is the single way to write into a chat (Telegram or Instagram); it enforces the Instagram 24-hour window. The Meta app is the service's own (`META_APP_SECRET`, `META_VERIFY_TOKEN`); each clinic stores only its account token, encrypted.
- Durable inbox: every incoming messenger event (Telegram, Instagram) is saved in `InboundEvent` before it is handled (`automations/inbound.service.ts`), a repeated delivery of the same id is ignored, a failure is retried with growing pauses (up to 6 attempts) by the scheduler and then kept as FAILED; the owner sees problems and can retry at `/integration-events` (patient texts are not shown). Handled events are purged after 7 days.
- Channels are adapters (`automations/channels.ts`, `telegram.adapter.ts`, `instagram.adapter.ts`) registered in `MessengerService`; each declares what the channel allows (initiate, reply window, buttons, templates). A new channel is a new adapter.
- Telegram: the bot is the clinic's own (token stored encrypted), long polling in development and a webhook with a secret in production.

## Reports
Computed by code from the database, never by AI. A report returns `{title, rule, dataUpdatedAt, generatedAt, columns, rows}`; export to CSV, Excel and PDF (`reports/report-export.ts`). Custom reports: `report-builder/` (datasets and fields whitelist, spec validation, grouping and totals). The AI assistant only builds a spec; the engine calculates.

## Messaging and AI
- `automations/`: scenarios and planner, outbox with approval, Telegram service, auto-reply, chat inbox, booking requests, staff chat, digest, campaigns, reviews, results measurement.
- `ai/`: `AiService` (single entry point: enabled check, monthly limit, usage), chat assistant (guardrails in `guardrails.ts`), owner assistant (question to report spec).
- Safety rules that code enforces, not only prompts: dangerous topics (health, prices, complaints) never reach the model; replies are checked for money, dosages, drugs and times outside computed free windows; patient names and phones are not sent to the model.

## Billing
- Plans in `service/plans.ts`: START 1,990 UAH, PRO 3,990 UAH per month, CUSTOM by agreement; no free period. The first payment is the one-off connection ($99 converted at the NBU rate, `billing/fx.service.ts`) plus the first month; later payments are renewals. Renewals are orders the owner pays on the billing page (the owner gets reminder emails); LiqPay automatic charging is not used yet.
- `billing/`: `BillingService` (checkout, signed LiqPay callback applied once per order inside a transaction, hourly status step ACTIVE -> PAST_DUE -> LAPSED with one email per step), `liqpay.ts` (signature), `BillingPayment` rows.
- Access: with `BILLING_ENFORCED` (on in production) a clinic that has not paid, or whose 5 grace days have passed, can open only `/auth/*`, `/billing*` and `/service/*` (`AuthGuard`, `accessBlocked` in `plans.ts`); data is kept. Demo clinics (`isDemo`) are never locked.
- AI replies: included replies per paid period (`Clinic.aiMonthlyLimit`, renewed on payment via `periodStartsAt`) are spent first, then bought ones (`Clinic.aiPurchased`, carried over). Billable = a reply to a patient, a draft or an assistant request; retries of one request are not billable. With nothing left `AiService` throws `ai_limit` and the auto-reply hands the chat to staff as a request.
- Features by plan are checked on the server with `hasFeature`: own AI replies, a second channel (Instagram), daily digest need PRO.

## Connecting Facebook and Instagram
- Primary way: Facebook Login for Business (`automations/meta-login.service.ts`, `meta-login.api.ts`). `GET /automations/meta/oauth` redirects the owner or manager to `facebook.com/<version>/dialog/oauth` with `config_id` (no list of permissions), `response_type=code`, a signed 10-minute `state`; `GET /meta/oauth/callback` (public) checks the state and the role again, exchanges the code (secret in the body), asks `debug_token` what the token is and which pages the person picked (granular permissions), keeps a 15-minute `MetaConnectSession` (encrypted token, page list, no page tokens) and, when there is more than one page, shows a choice. The chosen page's token is taken, Messenger (`MESSENGER`, entry id = page id) and the attached Instagram account (`INSTAGRAM`, entry id = Instagram account id) are connected with `config.mode = FACEBOOK_LOGIN`, and the page is subscribed (`messages,messaging_postbacks`, and `leadgen` as a best effort). Instagram messages of such an account go through `graph.facebook.com` with the page token (`InstagramAdapter.apiFor`), not through the Instagram Login address.
- Permissions decide what is connected, each independently: `pages_messaging` -> Messenger; `instagram_manage_messages` + an Instagram account on the page -> Instagram (its token is the same page token; Messenger is not needed); `leads_retrieval` -> lead forms (the lead is looked up through whichever of the two connections holds the page). With neither messaging permission nothing is connected (`meta_no_permissions`). Without `pages_messaging` the page subscription (`messages`) is only tried: a refusal is stored as `config.subscribeWarning` and does not break the Instagram connection; Instagram delivery also depends on the app-level webhook setting in the Meta dashboard.
- Token life: the configuration issues a system-user token, which does not expire, so nothing is refreshed on a schedule. `checkTokens` (every 6 hours) calls `debug_token` for every FACEBOOK_LOGIN connection; a revoked token or one that ends within 7 days sets `config.tokenProblem` (shown on the page) and one letter goes to the owner per clinic. `InstagramService.refreshDue` (the 60-day refresh of the older Instagram Login) skips these connections.

## Lead intake
- `automations/leads.service.ts`: `POST /leads/:key` (public; the secret key is in the address, a browser must come from a site the clinic listed, a plugin on a server has no Origin) accepts JSON or a classic form with the usual field names (name, phone, message, utm_*, page), ignores a filled "website" trap field, is rate limited, and writes an `Inquiry` (the same list the funnel uses; channel from the UTM source: Instagram/Facebook, Google, else Site) with the campaign marks. A repeated press (same phone and channel within 10 minutes) or a repeated delivery of the same lead id creates nothing new. Staff are told in the staff chat and by push (no names). Settings at `/automations/leads`.
- Meta Lead Ads: the Messenger webhook also carries `leadgen` changes; each is stored in the durable inbox (`LEADGEN`), the lead is fetched with the page token of the connected Messenger page (`FacebookApi.getLead`, needs `leads_retrieval`) and retried on failure.

## Automation builder
- `automations/custom-automations.service.ts`: a clinic builds its own automations next to the 9 fixed scenarios (which stay as they are). An automation = trigger (before a visit, after a visit with a status and a delay, no visit for N days, unfinished treatment, birthday) + conditions (source, visits count, doctor, service, no other future visit) + action (a Telegram message or a request for the administrator) + stop rules. Six templates (`TEMPLATES`) are ready to copy. Nothing runs until switched on, and changing the content switches it off again.
- Every 5 minutes the scheduler looks for people it applies to (our copy of the data only), writes to the same outbound queue (rule key `auto:<id>` for service messages, `auto-m:<id>` for invitations that need consent and count in the one-in-14-days limit) and records what it did (`AutomationHit` keeps one action per visit or per patient and period; `AutomationRun` is the journal with the reasons for skipping). The queue re-checks before sending: the automation is still on, the patient has not booked (`ifBooked`) or answered (`ifReplied`), plus all the usual checks (consent, pause, window, expiry). A preview counts the audience without writing anything, for a saved automation and for a draft.

## Waiting list
- `automations/waitlist.service.ts`: `WaitlistEntry` (wishes: doctor, weekdays, hours; lives 30 days) and `SlotOffer`. Every 5 minutes `tick` compares the free windows of the schedule (`ReportsService.freeSlots`, our copy of the data) with the wishes and offers a 30-minute start, at least 2 hours ahead, to the person who has waited longest, over Telegram through the outbound queue (rule `waitlist-offer`, approved by itself when the clinic sends service messages automatically). `SlotOffer.activeKey` is unique per clinic, so the database never holds one window under two open offers. The time to answer (3 hours, never past 30 minutes before the visit) starts when the queue really sends the message. "Suits me" is an atomic claim (`respond`): the time is held and a booking request for the administrator is created; "does not suit me", silence, a cancelled queue message or a late press free the window for the next person. Writing the visit to Cliniccards stays the guarded manual step. A patient can only be offered a time over Telegram (other channels do not allow writing first).

## Scheduled reports and alerts
- `insights/`: a saved report of the builder can be mailed as Excel or PDF daily (Pro), weekly or monthly (`ScheduledReport`, next run computed in the clinic's time zone, claimed atomically so a report is never sent twice). Recipients are members of the clinic only (never a typed address), and the report is calculated for each recipient with their own role, so a role without access to money fields gets nothing instead of a leak; every send is written to the audit log. `MailService` supports attachments (Resend and SMTP).
- Alerts (`AlertRule`, Pro): cancel and no-show share, fall of completed visits against the previous period, requests waiting too long. Calculated by code from our copy of the data, a sample under 10 visits is ignored, a rule that fired is quiet for 24 hours; delivery to the staff Telegram chat, push (no numbers) and the owner's email.

## Channels
- One adapter per channel (`channels.ts`, registered in `MessengerService`): TELEGRAM, INSTAGRAM, MESSENGER (Meta Graph, `meta.adapter.ts`), WHATSAPP (Cloud API), VIBER (behind `ViberProvider`, partner not chosen: `NoViberProvider` by default) and WEB (the widget). Every channel except Telegram hands incoming messages to `IntakeService` (save, "stop", a tapped time becomes a request, AI answer, one polite reply a day) through the durable inbox. Instagram and Messenger share `MetaChatService` (signed webhook, one account per clinic, 24-hour window).
- Instagram connects with a button (Instagram Business Login: signed `state`, 60-day token refreshed by `refreshDue`); a pasted token stays as a support fallback. Needs `META_APP_ID`, `META_APP_SECRET`, redirect address `{WEB_ORIGIN}/backend/instagram/oauth/callback`.
- WhatsApp: the sender number is vouched for by WhatsApp, so exactly one card with that phone is linked automatically. Replies only within 24 hours; templates (needed to write first) are not built (`caps.templates`).
- Web chat (`webchat.service.ts`, `public/widget.js`): public routes under `/webchat/:key`, a clinic key plus the clinic's list of site addresses (Origin), CORS answered per clinic, a signed 24-hour visitor session (separate secret), rate limits, never linked to a card automatically. Settings at `/automations/webchat` (owner, manager; Pro plan).
- All channels except Telegram need the plan feature `multi_channel` (Pro). Messages per channel this period are in `GET /service/usage` (`channels`); provider fees are billed to the clinic by the provider, not by us.

## Clinic knowledge base
- `KbItem` (services with duration and price, doctors, addresses, FAQ), edited by owner and manager at `/knowledge` (the administrator reads). Only approved and active entries reach the model (`KbService.factsFor`); a change of content removes the approval; a price is quoted only if confirmed within 90 days (`PRICE_FRESH_DAYS`). With a long price list (more than 40 services) only the services that match the patient's words are put into the prompt (at most 25) plus the list of directions, and only their prices may be quoted. Import from the Cliniccards price list (verified on 112 dental) decodes HTML entities, treats a price of 0 as not set, keeps the description and the group, and creates drafts only (its currency is unknown, so a person confirms each price).
- Guardrails (`ai/guardrails.ts`): `incomingHandoff(text, pricesKnown)` and `replyViolates(reply, allowedAmounts)` - a reply may contain only the amounts of fresh approved prices.

## Writing to Cliniccards
- Off by default, three keys: server `CLINICCARDS_WRITE_ENABLED`, server `CLINICCARDS_WRITE_LIVE` (only for the real address) and the clinic flag `bookingWriteEnabled` (service owner, `/platform`). Never run against a real clinic until the manual verification stage.
- `booking/booking.service.ts`: create, reschedule, cancel, confirm visits and create a patient. Each write has one unique `BookingAttempt` key (a repeated click or request returns the first result), the place is checked against fresh data from Cliniccards just before the write (taken cabinet or doctor, blocked cabinet, patient already booked), a failed read means no write, and an answer we did not get puts the attempt in `UNKNOWN`: the next try first looks in Cliniccards (`reconcile`) and never writes blind. A new patient is matched by phone first, so no duplicates. Identity in a chat is checked by code (surname or birth date) before a chat is linked to a card.
- The AI does not write: "AI creates appointments itself" stays locked (`BOOKING_WRITE_SUPPORTED=false`); only staff press "Book" on a request.

## Demo
- `POST /demo/start` (public, 5 per hour per address, at most `DEMO_MAX_ACTIVE` live copies) creates a clinic with `isDemo`, a made-up owner and fills it through the normal sync with `DemoConnector` (made-up patients), plus chats, requests, inquiries and ratings (`demo/demo.service.ts`). The copy lives 6 hours, then `purge()` deletes it with everything in it.
- A demo never touches real systems: `MessengerService.send` returns without sending, the demo mail domain is never mailed, `AuthGuard` refuses (403 `demo_restricted`) writes to integrations, team, billing and imports, and the AI has a small allowance per copy plus a shared daily budget (`DEMO_AI_DAILY_CAP`, default 200). Demo clinics are never locked by billing.
- The public landing page is `apps/web/components/Landing.tsx` with its text in `lib/landing-text.ts` (uk/ru/en). Prices there repeat `service/plans.ts`; an integration is marked "working" (`live: true`) only after a live check.

## Web
App Router pages in `apps/web/app`. API client `apps/web/lib/api.ts` (cookie session, no token in storage). Mobile first at 390 px; tables turn into cards on phones.

## Known simplifications
- Free windows are computed by cabinet when Cliniccards has no doctor shifts; with shifts they are per doctor.
- Plans and limits exist but there is no billing; the platform-owner view is a simple table.
- Instagram works only as an inbound/reply channel inside the 24-hour window (no mass mailings, no scenarios); SMS is not implemented and not planned.
- No refresh tokens; the session lasts 12 hours.
