# Reminders and messages to patients: what is possible and how it is built

A document for the project owner and the clinic owner. The analysis and the current status: Telegram messaging, the chat inbox and the AI replies are built (see "What is built"); nothing has been verified on a live bot yet.

## 1. What the clinic owner wants
The program contacts patients by itself:
- reminders about an appointment;
- patients who did not come;
- patients who were for a cleaning about a month ago (decided: a repeat-cleaning reminder, see the decisions);
- "and so on" (the list of scenarios is in section 4).
Channels: Telegram first, then WhatsApp or Viber (decided: SMS) for people who have no Telegram.

## 2. The main constraint: how messengers allow writing to people at all
No messenger lets you just take a number from the database and write to a person without their involvement. Each has its own rules.

| Channel | Can you write by phone number | What is needed | Cost |
|---|---|---|---|
| **Telegram** (bot) | **No.** A bot writes only to someone who pressed "Start" at the clinic's bot. A person cannot be found by number. Using personal accounts instead of a bot is forbidden by Telegram's rules and risks a ban | the patient subscribes to the bot once | free |
| **Instagram** (official API) | **No.** A business account can answer only someone who wrote to it first, usually within 24 hours of their last message; you cannot find a person by number | a Meta business account, app review | free |
| **Viber** (business messages) | Yes, by number, but only through a paid partner provider | sender name registration, templates, a contract | paid per message |
| **WhatsApp Business** (official API) | Yes, by number, but **the first message only from a pre-approved template**, and the person must have consented | a Meta Business account, business verification, templates | paid per conversation |
| **SMS** | Yes, by number | an SMS provider | paid per message |

Cost and terms differ between providers and change; check them when choosing (for example aggregators such as Infobip or Twilio, Ukrainian SMS services).

### What this means for "Telegram first"
The clinic has 3,500 patients and **none of them is subscribed to the bot yet**. So on day one the Telegram channel reaches zero people. Coverage has to be **grown**: the administrator shows every arriving patient a QR code or gives a link ("connect reminders in Telegram"), the patient presses "Start" and shares a phone number, and we match it to a card. Realistically part of the patients subscribe over several months, not all.

So for appointment reminders (the most important ones) a **fallback channel by phone number** is needed: SMS (chosen) or Viber. The order: Telegram (if subscribed) → SMS.

## 3. Consent, the law and sensible limits
- A **reminder about a booking** to a patient who booked themselves is a service message under the contract. **Marketing** (bringing back, offering a cleaning, promotions) needs consent. The program has a consent field on every patient (unknown / given / withdrawn). The project principle: **no consent, no automatic marketing**. For a clinic whose patients all sign the standard consent, the owner can confirm this once in settings; "withdrawn" still always blocks.
- **Before autonomy is turned on** (the clinic's decision) messages do not go out by themselves: the program prepares a list "whom and what we will send", a staff member checks and approves. The master sending switch is off by default.
- A patient can always opt out (the command "Зупинити" in the chat) and then we stop writing (the card also has "Pause automatic contacts").
- **Quiet hours** (nothing at night, sending only 08:00–22:00 Kyiv time), **frequency limit** (at most one promotional message per patient in 14 days), **de-duplication** (never send the same twice).
- **Content without medicine:** "Reminding you of a visit tomorrow at 15:00, clinic 112 dental". No diagnoses, services or amounts: that is health data and the messenger is a third-party subcontractor.
- The registration agreement names Telegram and the AI provider as subcontractors (done, version 2026-10-29).

## 4. Scenarios (each is switched on separately)
| Scenario | When it fires | Where the data comes from | Kind |
|---|---|---|---|
| Appointment reminder | N hours before a visit (default 24) | future visits "Planned" or "Confirmed" | service |
| No-show | on the day of a no-show: "We did not wait for you, shall we reschedule?" | status "Did not come" | service |
| Thanks after a visit | the next day after a visit | visit "Visited" | service |
| Visit rating | a few hours after a visit: buttons 1–5; low ratings become a request for the administrator | visit "Visited" | service |
| Repeat cleaning | N months after prophylaxis (default 6) | completed services of the group "Профілактика" | marketing |
| Continue treatment | started but unfinished plan, patient not booked, N days without a visit | plan items + visits | marketing |
| Lapsed | N days without a visit (default 180), not booked | patients | marketing |
| Birthday | on the birthday | the birth date from Cliniccards | marketing |
| Campaign (custom promotion) | when the manager queues it | audience filters chosen by the manager | marketing |
Not built yet: "ask to confirm" (reply "Yes"), cancellation or reschedule without a new booking, a website inquiry without a booking.
Debts are not included by default: a sensitive subject, better handled separately.
Marketing scenarios fire only when the "no visit" period came due in the last 14 days, so switching one on does not send to the whole history.

## 5. How it is built in the program
- The page **"Автоматизації"** (one place for everything): the bot mode (off / staff only / AI drafts / AI replies by itself), the manager AI assistant switch, the consent setting, the Telegram bot with QR and the staff chat, the manager digest, scenarios with texts and a preview ("how many will receive it today and who"), campaigns, the approval queue and the message log.
- The approval queue: a staff member checks and approves. Service messages can go out without approval if the clinic allows; marketing always needs approval.
- The message log: to whom, what, when, status (queued, sent, failed, cancelled, expired).
- In the patient card: whether Telegram is connected, the message history, the "do not write" button.
- **A closed loop** with the funnel: the analytics page shows after a message whether the person replied (7 days), booked (14 days) and came. This answers the owner's question whether the mailings work. It is a coincidence in time, not proof of cause.
- The page **"Листування"** (the inbox): patient replies, with tabs Chats and Requests. The administrator answers by hand, or presses "AI draft" and edits, or the AI replies by itself (mode "AI replies by itself"). Booking, reschedule and cancellation intents and questions that the AI hands over become **requests** with a badge in the menu and a message to the **staff chat**; the administrator enters the appointment in Cliniccards and marks the request done.
- The **manager digest** in Telegram (weekly or daily) with numbers against the previous period and what needs attention.
- The **quality page** collects ratings from the bot; low ratings go to the staff chat at once.

## 6. What is needed from the clinic
- A Telegram bot: created in 2 minutes through @BotFather, the token is entered on "Автоматизації" (free).
- A QR code and a reminder on the front desk: "Connect reminders".
- Choosing the fallback provider (SMS) and a budget.
- Message texts (prepared as defaults, the owner edits).
- A link for public reviews (Google etc.) for the rating scenario; the staff chat group; recipients of the digest.

## 7. What was done before accounts existed
The whole core: scenarios, templates, the approval queue, the log, quiet hours and limits, opt-out, the preview, binding a patient to Telegram, the Telegram bot. Checking on live people needs only a bot token. Connecting SMS and Instagram later through the chosen provider changes nothing else.

## 8. Order of work
1. ✅ **Stage 1:** core + Telegram: reminders, no-show, the approval queue, the log, patient binding by QR and link, opt-out.
2. ✅ **Stage 2:** return scenarios (cleaning, treatment, lapsed), thanks, rating, birthday, campaigns, results in the funnel, quiet hours and limits.
3. ✅ **Stage 4:** the inbox "Листування", AI drafts, AI auto-replies with guardrails, booking requests, staff chat, digest.
4. **Stage 3:** the fallback channel by number (SMS), the chain "Telegram → SMS": not started, the provider is not chosen.
5. **Instagram + AI:** not started (the account and access exist).

## Decisions
- "Were for a cleaning about a month ago" = the **repeat cleaning** scenario: remind about prophylaxis after a configurable period since the last one (default 6 months; any value, including 1 month).
- The fallback channel for people without Telegram: **SMS**. The chain: Telegram (if subscribed) → SMS.
- Until the owner switches on automatic sending, all messages go through the approval queue.
- The clinic currently reminds patients by hand (calls and messages), not through Cliniccards, so duplication is possible only with those manual reminders: agree when to switch the reminder scenario on.
- All patients sign the standard consent: handled by the owner's confirmation setting (check the wording of the paper).
- One service-wide AI key; a clinic switches the features on and has a monthly reply limit.
- The AI never creates appointments: it prepares a request; writing to Cliniccards stays off.

## What is built (details)
- Telegram bot connection (a token from @BotFather), a QR code and a link for patients; in the patient card a personal link and the message history.
- All scenarios in section 4, each with an editable text and a preview; a master switch "Відправка повідомлень пацієнтам", off by default, and the bot mode choice; the sending window, expiry, re-checking of consent, pause and visit status right before sending, opt-out with "Зупинити".
- Campaigns: name, text with `{name}` and `{clinic}`, filters "not seen from/to N months" and "no upcoming booking", an audience preview with the reasons for exclusion, creating messages in the queue only for patients with consent.
- Auto-reply guardrails: dangerous topics (health, prices, complaints) are handed to a human before the model is called; replies with amounts, dosages, drugs or times outside computed free windows are replaced by a hand-over; at most 6 AI replies per day per chat; staff replies silence the AI for 30 minutes; free windows are offered as buttons and per doctor when shifts exist.
- Checked: automated tests with a fake Telegram and a fake AI (about 235 tests), the real AI model on made-up dialogs (`RUN_AI_EVAL=1 npx jest test/ai-eval.spec.ts`), and a browser at 390 px. **Not checked on a live bot.**

## 9. Questions for the clinic owner
1. Does Cliniccards itself already send reminders (SMS or Viber), so that a patient would not get duplicates? (The clinic reminds by hand now; confirm.)
2. Does the paper consent explicitly cover informational and promotional messages in messengers?
3. May we start with appointment reminders only and add the return scenarios later?
4. Who will show the QR code to patients and when (the front desk at every visit)?
5. Which Google review link should patients with high ratings receive?

## Reviews
The invitation to leave a public review (`Clinic.reviewUrl`) goes to every patient who rates a visit, whatever the rating; a rating of 3 or lower additionally asks for a private comment and creates a request for the manager. Sending the link only to satisfied patients is not done on purpose: review platforms forbid selecting who may review.

## Instagram (built on fakes, not verified live)
- Direct messages of the clinic's business account arrive in the same inbox (badge "Instagram"). The AI answers by the same mode switch as in Telegram, with the same guardrails; times are offered as quick-reply buttons and a tap becomes a request for the administrator.
- Platform rules that shape it: a business may answer only within **24 hours** after the person's last message (the code enforces it and the inbox shows why a reply is closed); it cannot start a conversation, so there are no reminders, campaigns or scenarios in Instagram. A nickname is linked to a patient card by hand from the inbox.
- The sender of a message is an Instagram-scoped id, not a phone number, so patients are never matched automatically.
- Live check needs a public https address, the Meta app and its review (`docs/02-hosting-and-security.md`).

