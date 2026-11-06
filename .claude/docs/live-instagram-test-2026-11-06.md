# Live Instagram test of the autonomous agent (2026-11-06)

Setup: current code run locally (own database, API 3101, site 3100) behind an ngrok tunnel; the existing Meta app's Instagram webhook was moved to the tunnel for the test window; the existing Ridno Page and `@ridno_service` Instagram account were connected to a local synthetic clinic "LANKA Live Test"; Cliniccards was the local mock (no live key, no live write). Autonomy was on for ONE dialogue (`AGENT_AUTO_DIALOGS` and `AUTOBOOKING_TEST_DIALOGS` held that single key). Production code, database and live Cliniccards were not touched.

## Result
Passed on a real Instagram channel (owner's tester account, mobile app):
- webhook received (first real-channel check of the webhook fields and the send call);
- first message after switching autonomy on was answered at once (the earlier "test 1" message was picked up);
- price question: code answer, 100 UAH test price, preliminary-price notice, "Підібрати зручний час?";
- "Так, підберіть": three time options sent; the whole test was done from the DESKTOP Instagram, where the buttons are not shown, and the time was chosen as text ("Обрав час: 06.11 14:30") which the agent accepted (the owner saw the buttons on mobile, but a button TAP was not tested);
- chosen time -> one contact question; surname, first name and phone in one message -> summary with the normalised phone; "так" -> one visit and one new patient card in the mock, confirmation sent;
- repeated "так" -> short code answer "already confirmed", no second visit; "дякую" -> short answer. Totals: 1 BookingAttempt PATIENT, 1 CREATE, request DONE, notice SENT.
- model use: 3 calls, 13550 input and 872 output tokens (well under the $0.25 budget).

## Findings and limits
- Buttons are not shown by Instagram on desktop (owner's observation); the typed choice works there (verified live). A real button TAP on mobile, and a tap on an OLD confirmation button, were not tested; postponed by the owner.
- The real Cliniccards write contract was not exercised (mock only); the live visit needs a separate, explicit go-ahead (see the owner conversation).
- Autonomy answered a message that had arrived before it was switched on; keep in mind when enabling it for a dialogue with history.

## Where the raw material is
The raw local runs of the model evaluation (`apps/api/eval-output/`, synthetic dialogues and budget ledgers, no secrets or real contacts found) are excluded from version control (`.gitignore`); their findings are summarised in `agent-administrator.md` sections 18-22. The test fixture the suite needs stays in `apps/api/test/fixtures/agent-eval-run2.json`.

## Cleanup
Local agent switched off first (`aiAgentAuto`, `aiAgentMode`, `bookingWriteEnabled`, `sendingEnabled` off), production webhook restored and checked by the owner (incoming message appears, manual reply reaches Instagram), then the test processes were stopped and the temporary secrets, tokens, test database and test build removed.
