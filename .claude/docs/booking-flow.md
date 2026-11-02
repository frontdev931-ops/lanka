# Booking through the bot

One scenario for every channel (Instagram, Messenger, WhatsApp, Viber, web chat through `IntakeService`; Telegram through its own callback and message handlers). The code lives in `apps/api/src/automations/booking-flow.service.ts`; the state is kept on the `BookingRequest` row (one open request per chat), so it survives a restart.

## Steps
1. The person taps a time button: `onSlotChosen` saves the time, the service and the doctor on the open request (stage `COLLECT`). The staff is not notified yet.
2. If the name or the phone is missing (a linked card with both is enough), the bot asks for the missing part only. `onText` takes the answers (`parseContact`: a name needs two words and no question words; a phone is normalized). After 3 asks the request goes on with what it has. A typed phone never links the chat to an existing card.
3. `complete` (claimed once through stage `READY`): the summary is rebuilt with channel, name, phone, service, time and doctor, the staff is notified once ("Оновлення заявки"), then:
   - default mode: the client is told "Передали заявку ... Очікуйте підтвердження запису" (not that the booking is made);
   - automatic mode: `runAuto`.
4. The administrator presses "Внесено в Cliniccards" on a booking request: the form is prefilled from the visit found in Cliniccards (`GET /requests/:id/match`, a read) or from the chosen time; `POST /requests/:id/confirm` stores the actual data, marks the request done and sends the confirmation with the actual data. Nothing is written to Cliniccards. A repeat click returns `alreadyConfirmed` without sending.
5. Delivery state is on the request (`noticeStatus`: PENDING, SENT, FAILED, SKIPPED, with `noticeError`). The message row `bookconfirm:<requestId>` in `ChatMessage` is the claim, so there is one message per request. `POST /requests/:id/notice/retry` re-sends a FAILED or SKIPPED one; a PENDING one older than 5 minutes only with `force`. Channel limits are not bypassed (a closed reply window stays `window_closed`).

## Automatic mode
On only when all of these hold: the clinic's `aiAutoBooking`, the clinic's `bookingWriteEnabled`, the connector can write, and the service-wide `CLINICCARDS_WRITE_ENABLED=true` (the setting itself cannot be turned on without it; `bookingWriteSupported()` in `ai.service.ts`). It then:
- uses the linked card, or creates a new card only when no card has the phone (an existing card with the phone goes to the administrator: a phone alone is not proof);
- takes the visit length from the approved service in the knowledge base (default 30 minutes) and a free cabinet/doctor from the same schedule the offers came from;
- books through `BookingService.book` (fresh re-check of the place, one unique attempt key, read-back);
- a taken place: fresh times are offered as buttons and the request stays open; an unknown result (lost answer): the booking is checked once more before anything else; any other failure: the request goes to the administrator and the client is never told "you are booked";
- only after a successful answer is the client told, with the real time. The audit row `booking_request.confirmed` says `by: auto` or `by: admin`.

## Tests
`apps/api/test/booking-flow.spec.ts` (both modes on the Cliniccards mock, several-message collection, the administrator changing the time, a taken place, a lost answer, a refusal, a repeated tap or click, a delivery error and its retry, a card with the same phone, the switches).

## The AI pause and why the AI can stay silent
- A person's answer in a chat pauses the AI for 30 minutes (`AutoReplyService.pausedUntil`). The thread shows "ШІ мовчить до ..." with a "Повернути боту" button (`POST /conversations/:channel/:chatId/resume-bot`, table `ChatBotResume`). Only messages with an author (a person) pause the AI; scripted messages of the booking flow and the booking confirmation have no author and `byAi: false`, so they neither pause the AI nor use up its daily allowance (6 model replies per chat per day).
- The booking flow takes a message only while it waits for a name or a phone, only when it really replies, not for a question (`?`) and not when the request is older than 6 hours.
- Every reason the AI did not answer is logged as a code (`AI autoreply skipped: <reason> (clinic <id>, <channel>)`): `clinic_suspended`, `ai_off`, `autoreply_off`, `sending_off`, `plan_without_autoreply`, `opted_out`, `paused_after_staff_reply`, `daily_ai_reply_cap`, `send_failed_*`. Flow side: `Booking flow did not take the message: stale|question`. No chat ids, texts, phones or tokens are logged.

## Dental words and sudden health problems
- `apps/api/src/ai/dental.ts`: the glossary the model gets (чистка, вісімка/восьмёрка, панорама/ОПТГ, приціл, КТ, нерв/канали, імплант, брекети...) and the search expansion for the clinic's reference (the patient says "чистка", the price list says "гігієна"). Services are still named only from the approved reference.
- A message with a sudden problem (acute pain, a swelling/флюс, bleeding, a broken tooth) and no question about medicines, a diagnosis, prices or a complaint never reaches the model: `ChatAssistantService.urgent` answers in code (no advice, no evaluation; "103 or 112" if the person feels very bad), offers the nearest free times as buttons and creates a request whose summary starts with "ТЕРМІНОВО" (the staff is told even when an open request exists). With no free times it is a hand-over marked urgent. Medicines, diagnosis, fever, prices and complaints still go straight to a person.
