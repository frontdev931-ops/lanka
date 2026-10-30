# Personal data processing policy (DRAFT)

> **A draft for a lawyer.** This describes how the service works technically and lists the questions that must be decided. It becomes legally binding only after a lawyer reviews it under Ukrainian law (the Law "On Personal Data Protection") and, if data of EU citizens enters the system, under GDPR. Do not publish or sign it without that review.

## 1. Roles
- **The clinic** is the owner (controller) of its patients' personal data.
- **LANKA** processes this data on the clinic's instruction (operator/processor): it reads it from Cliniccards, stores it, shows it to the clinic's staff in reports and lists, and, when the clinic turns the features on, writes to patients through a messenger and uses an AI provider to prepare replies and reports.
- A written processing agreement between the clinic and LANKA is needed (the template: the points below).

## 2. What data is processed
- Patients: full name, phone, inquiry source, birth date (for greetings), date of the last visit, debt information, consent status for messages.
- Appointments: date, time, doctor/cabinet, service, status (came, did not come, cancelled, rescheduled).
- Treatment: names of services in the treatment plan, statuses, amounts. **This is information about health: a special category of data.**
- Finance: invoiced amounts, payments, invoices.
- Staff: name, email, role, action history, an optional two-factor secret (encrypted).
- Communication with patients: the Telegram chat id of a patient who pressed Start, the texts of messages written to the bot and sent by the clinic, visit ratings and comments, booking requests created from chats.
- **Not** read from Cliniccards: diagnoses, medical records, documents, patient files. The app only reads data and writes nothing to Cliniccards.

## 3. Purposes
Reports for the administrator and the owner (whom to call, no-shows, debts, free windows), the manager digest, patient funnel statistics, reminders and other messages to patients through the clinic's own bot, replies in the bot chat, quality ratings. Other purposes (advertising by LANKA, selling data, training models) are **not allowed**.

## 4. Grounds and consents
**Accepted approach:** the same as Cliniccards. A patient signs the clinic's standard personal data paper; patients are not notified separately about each service. The ground for processing is on the clinic's side. So what matters for us are the three checks (section "What must be checked").
- Consent for promotional and informational messages is stored in LANKA in a separate field (unknown / given / withdrawn). **No consent, no automatic promotional message.** Service messages (reminders about a booked appointment) do not need a separate consent. The clinic owner can confirm in settings that the standard consent covers promotions; this decision is written to the audit log, and a withdrawn consent always blocks.
- A bot writes only to people who started the chat themselves; a patient can stop messages with the command "Зупинити" at any time.
- Calls by the administrator from lists ("not booked after a visit", "unfinished treatment") are made by clinic staff on behalf of the clinic.
- Messages to patients contain no medical details.

## 5. Where and how data is stored
- Servers: the region is chosen by the owner of the service (recommendation: the EU). Write down the exact provider and region: ______________________.
- Encryption: connections only over https; the Cliniccards API key and the Telegram bot token are stored encrypted in the database (AES-256-GCM). Disk and backup encryption is on the database provider's side (check and write down).
- Backups: daily, retention: ______ days, then deleted.
- Retention: while the contract with the clinic is in force; after termination, deletion within ______ days.

## 6. Who has access
- Clinic staff by role (owner, manager, administrator, doctor, analyst). The doctor does not see patient money, the message log or the report builder. Roles are checked on every request. Two-factor sign-in is available to every user.
- LANKA developers: access to the production database only when necessary (support), with a record in the log. **Decide:** exactly who and on what terms: ______________________.
- Every clinic sees only its own data (isolation is verified by automated tests).

## 7. Subcontractors (subprocessors)
| Subcontractor | Why | What data | Region |
|---|---|---|---|
| API and database hosting: ______ | running the service | all clinic data | ______ |
| Site hosting: ______ | serving pages | does not store patient data | ______ |
| Mail service: ______ | password reset and verification mails | staff email and name | ______ |
| Telegram (the clinic's own bot) | messages to patients who started the chat | chat id, message texts | ______ |
| AI provider (Anthropic API): ______ | replies in the bot chat, drafts, the manager's report assistant (only if the clinic turns them on) | texts of patient messages in the bot chat, summary facts computed by the service (months since the last cleaning, free windows), staff questions and aggregated report totals; **not** patient names or phone numbers; no rows with patients | ______ |
| Cliniccards | data source (by the clinic's key) | none (we read from them) | none |

The AI features are off by default. Before using them on real patients: a data processing contract with the AI provider (and its terms on retention and use of data) must be concluded and the region recorded. The terms of service shown at registration name Telegram and the AI provider as subcontractors.

## 8. Patient rights and how to apply
- Access and correction: the data comes from Cliniccards; it is corrected there and refreshed here at the next load (hourly).
- Deletion: the clinic deletes the patient in Cliniccards; the whole clinic's data is removed from LANKA with the button "Видалити дані клініки" in settings. Deleting a single patient from LANKA: __ (decide whether it is needed). A patient can stop messages at any time with "Зупинити".
- Export: "Експорт даних клініки" in settings (JSON, without passwords and keys).
- Response time to a patient's request: ______ days. Responsible person: ______________________.

## 9. Incidents
- On a leak or a suspicion of one: close access, reissue keys and secrets, estimate the scope from the audit log, **notify the clinic within ______ hours**; the clinic notifies patients and the regulator if the law requires.
- Contact for reports of problems: ______________________.

## 10. Security measures (implemented)
See the section "What is already done in code" in `docs/02-hosting-and-security.md` and the limitations there.

## What must be checked (before connecting the next clinic)
1. **The clinic's personal data paper.** ✅ The owner confirmed that the standard paper permits passing data to subcontracted services and processing it to contact the patient. Ask again for each new clinic. Also confirm that it explicitly covers informational and promotional messages in messengers before the "standard consent" setting is turned on.
2. **The processing agreement between the clinic and LANKA.** ✅ Implemented as an agreement that the owner accepts **at registration** (a window with the checkbox "Я приймаю…", text in three languages: the `terms.*` keys in `apps/web/lib/i18n.tsx`). For clinics created earlier, the window is shown to the owner at the next sign-in. Acceptance is recorded: the clinic, who accepted, when, the version, the address (in the clinic table and in the `terms.accepted` audit entry). Until the agreement is accepted, Cliniccards data cannot be connected. Version `2026-10-29` added points 10 and 11 (messengers and the AI assistant as subcontractors, including the manager's report assistant). When the meaning of the text changes, bump the version in two places: `apps/api/src/common/terms.ts` and `apps/web/lib/terms.ts`.
3. **Cliniccards' terms for integrations.** ✅ According to the project owner the API is public and third-party integrations are allowed. For documentary certainty keep a written confirmation from Cliniccards support.

## Other questions for the lawyer (short list)
- Whether servers outside Ukraine are acceptable for such data and whether registration of processing is needed.
- The retention period after the contract ends.
- Requirements for access logs to health data.
- Whether messaging patients in Telegram on the basis of the clinic's standard paper is sufficient, and the wording the clinic should use to collect consent for promotions.
- Using an AI provider outside Ukraine for the texts of patient messages: what additional consent or notice is needed.
