# Security and patient data

Patient data is personal and medical. The decisions below are mandatory for the code; legal questions must be settled before production.

## Isolation, audit, access
- Clinic isolation: `clinicId` from the token in every request; a leak test between clinics is mandatory for every new endpoint.
- Audit: actions of staff and automations are written to `AuditLog` (sign-in, recovery-code sign-in, settings, approvals, exports, AI settings, terms acceptance).
- Sessions: httpOnly cookie, `Origin` check for cookie requests, the role is reloaded from the database on every request. Passwords are 10+ characters. Password reset and email verification use one-time links (only a hash in the database); a reset closes earlier sessions. Only a verified owner connects the Cliniccards key.
- Two-factor sign-in (TOTP) is available to every user: secret encrypted, a code can be used once, recovery codes are one-time and stored as hashes, attempts share the sign-in rate limit, turning it off needs the password and a code.
- Invitations are one-time links (only a token hash in the database, valid for 7 days; accepting as an existing user needs that user's password).
- Roles and money: payments and invoices are readable only by OWNER, MANAGER and ANALYST (enforced on the server, not only hidden in the menu). Patient debt is also open to ADMIN (they work with debtors). New financial reports are closed to ADMIN and DOCTOR by default. The report builder hides money fields and the payments dataset from other roles and refuses specs that use them. The doctor sees patients but no money and has no access to the message log, the inbox or the builder.

## Service access
- A clinic can be suspended by the platform owner (`Clinic.suspendedAt`): every request except `/auth/*` returns 403, the scheduler, auto-replies, the digest and the planner skip it, bot chats are not processed. Data is kept.
- The platform-owner endpoints (`/platform/*`) work only for verified emails listed in `PLATFORM_ADMIN_EMAILS`; clinic roles never give this access. Every change is written to the clinic's own audit log (`platform.clinic_changed`).
- The owner can require two-factor sign-in from all staff (`Clinic.require2fa`, only after turning it on for themselves). Until a member sets it up, the guard lets them reach only `/auth/*` (including the two-factor endpoints).
- Plan limits: staff (members plus open invitations), messages per month (messages over the limit wait, they are not lost) and AI replies per month.
- Staff management is owner-only: change a role, remove a member (open tasks lose their assignee), reset a member's second factor (closes their sessions). The owner and oneself cannot be changed.
- Viewing a patient card is written to the audit log (`patient.viewed`, at most once per 10 minutes for the same person and patient).
- Phone push notifications carry no patient data (only the kind of event); a subscription belongs to one user and is removed when the browser reports it gone.

## AI provider
- One service-wide key on the server (`AI_API_KEY`); clinics only switch features on. Each feature has its own switch and the clinic gets a monthly reply limit; the usage journal keeps counters, never text.
- What may leave to the provider: the text of a patient's message in the bot chat, summary facts computed by code (months since the last cleaning, free windows, whether a patient is known), the text of a staff question to the owner assistant, and aggregated report totals. Patient names and phone numbers are never put into prompts; rows with people are never sent. The terms of service list the AI provider and Telegram as subcontractors.
- Code-level guardrails (not only instructions): dangerous topics (health, complaints, discounts and instalments) are handed to a human before the model is called; a plain price question reaches the model only when the clinic has approved prices confirmed in the last 90 days, and a reply may then contain only exactly those amounts (any other amount, or a price from a draft or an expired entry, is replaced by a hand-over); the reply is checked for amounts, dosages, drugs, diagnoses and times outside the computed free windows; long conversations are handed over; the model never creates appointments (writing to Cliniccards is off).
- Calculations in reports are done by code, never by AI. The AI only builds a report description (spec) or explains aggregated numbers.

## Messaging to patients
- A bot writes only to people who pressed Start themselves. Service messages (reminders) follow the clinic's settings; promotional messages need consent. Consent is `UNKNOWN`, `GIVEN` or `WITHDRAWN`; the owner can confirm that the standard consent covers promotions (`Clinic.assumeConsent`), and `WITHDRAWN` always blocks. A patient opts out with "Зупинити".
- Every message is re-checked before sending: consent, pause, opt-out, visit status, sending window 08:00–22:00 Kyiv time, expiry. The master switch `Clinic.sendingEnabled` is off by default and blocks all patient messages; replies, auto-replies and campaigns respect it. Staff notifications (staff chat, digest) are internal and do not depend on it.
- At most one promotional message per patient in 14 days (a birthday greeting is not counted).
- Message texts contain no medical details.

## Instagram
- The webhook has no sign-in; each request is accepted only with a valid `X-Hub-Signature-256` (HMAC of the raw body with `META_APP_SECRET`), and the GET address check needs `META_VERIFY_TOKEN`. Unknown accounts and bad signatures are ignored silently.
- An account belongs to one clinic (a second clinic cannot connect the same account). The token is stored encrypted and sent only in a header.
- Replies only within 24 hours of the person's last message; no first messages, no promotions. Repeated webhook deliveries are ignored by message id. "Stop" is honoured (for a stranger the earlier stop message is the mark); staff can still answer by hand.

## Web chat widget and other channels
- The widget's public routes accept a request only with a valid clinic key and an `Origin` on the clinic's own list (a wrong key and a wrong site look the same: 404, no CORS headers). A visitor is anonymous and gets a signed session of 24 hours; messages are limited per session (20 per 10 minutes) and per address; the clinic's AI allowance is the final cap. A chat is never linked to a patient card by what the visitor types; staff link it.
- WhatsApp links a chat to a card by the sender's number only when exactly one card has it (the number comes signed from Meta). Messenger, WhatsApp and Instagram webhooks need the Meta signature; a Viber partner's handler must do its own check before calling `ViberService.receive`.
- The Instagram sign-in `state` is signed (HMAC) and short-lived; the clinic comes only from it, and the role is checked again when the person returns.

## Meta compliance callbacks
- `POST /meta/deauthorize` and `POST /meta/data-deletion` are public and accepted only with a valid `signed_request` (HMAC-SHA256 with the Facebook or the Instagram app secret). Deauthorize deletes the connections (and their tokens) whose account id equals the user id; data deletion also deletes the conversations, chat links and requests carrying that id, writes a `DataDeletionRequest` and returns a code; the public status page shows only counts, never the id. The clinic's own records of a patient are not Meta data and stay with the clinic. Connections made by pasting a token are matched by the account id only: a person identified by another id is not found.

## Data handling
- Integration secrets and tokens (Cliniccards key, Telegram bot token) are stored encrypted (`common/crypto.ts`, `ENCRYPTION_KEY`).
- File upload: up to 5 MB and 20,000 rows, format detected by content not by name; values are stored as text and never interpolated into SQL; an import is protected against re-applying and is bound to the clinic.
- CSV, Excel and PDF exports are written to the audit log; CSV cells starting with `=`, `@` or a sign are escaped against formula injection; Excel stores strings as text.
- The Cliniccards address cannot be replaced in production (`CLINICCARDS_BASE_URL` is ignored), otherwise a clinic key could be sent to another server.
- Do not commit `.env`; do not print tokens or personal data to logs; tests never call real external services.
- Storage region, retention periods, export and deletion of clinic data: see `docs/03-personal-data-policy.md`; they must be settled before the first paying client.

## Review of 2026-10-30 (whole architecture)
Checked by reading the code and by tests: every query on clinic data is filtered by the clinic from the token (an id from the request is looked up with `clinicId` before it is changed; foreign ids in a request body, such as patient, assignee, report, recipient, are checked to belong to the clinic); every authenticated route has a role or is deliberately open to all roles; the public routes (demo, sign-in, health, invitations, webhooks of Telegram, Instagram, Messenger, WhatsApp, Meta callbacks, web chat, lead intake, the LiqPay callback) each have a proof (signature, secret key, signed state or token) and limits; no raw SQL with variables, no `innerHTML`, no shell commands, no request-driven server-side fetch (every outgoing address is fixed, the Cliniccards address cannot be replaced in production).
Added in that review: a signed-out session token is refused (`RevokedToken`, token id in `jti`); an unknown email costs the same time as a wrong password; the team list is not shown to the doctor and the analyst; the service-owner overview needs two-factor sign-in in production; the Telegram webhook finds the clinic by the secret in the database and compares it in constant time; each signed value has its own key (`JWT_SECRET` + a purpose); production start refuses development leftovers.

## Known gaps
Besides the list below: tenant isolation is enforced in the application and by tests, not by PostgreSQL row-level security (a possible second layer); the encryption key is the SHA-256 of `ENCRYPTION_KEY` with no versioning, so rotating it needs re-encrypting the stored tokens by a script; sign-up answers "email already taken" (rate limited) and so shows whether an address exists; there is no list of devices to sign out one by one; the page CSP allows inline scripts (Next); authenticated routes have no global request limit (put rate limiting at the host or CDN as well); the client address used by the limits depends on the proxy chain (check `X-Forwarded-For` after the first deployment). Status and details live in `docs/02-hosting-and-security.md`. In short: an import cannot be undone after applying; the doctor sees all patients (without money); a clinic export is assembled in memory; two dependency findings remain from Next.js 15 (an upgrade to Next 16 is needed; NestJS is already 11 and NestJS 12 is incompatible with this CommonJS project); there is no mandatory two-factor policy for all staff and no administrator reset of a lost second factor; hosting, HTTPS, real mail and backups are still to be set up.
