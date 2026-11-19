# LANKA payments with plata by mono

Online checkout uses a one-time debit on the bank's hosted payment page. Users initiate renewals from the existing billing screen. LANKA does not handle card numbers, request card tokens or create regular payments.

## Railway configuration and release

1. On the **API service → Variables**, set the secret `MONO_ACQUIRING_TOKEN` and confirm the existing `WEB_ORIGIN=https://app.lankaclinic.app`. Keep the current value of `BILLING_ENFORCED`. Keep `PLATFORM_ADMIN_EMAILS` configured for billing exceptions. Never add the acquiring token to the web service or to any `NEXT_PUBLIC_*` variable.
2. Apply the additive migration `20261118160000_mono_acquiring` with `prisma migrate deploy`. In Railway the API image runs it before starting Nest. Existing orders, provider references and entitlements are retained.
3. Release the API and then the matching web app, and confirm the web service's existing `API_URL` reaches that API. The public webhook is `POST https://app.lankaclinic.app/backend/billing/mono/webhook`. LANKA passes it as `webHookUrl` for each invoice. A merchant-cabinet webhook entry is unnecessary.
4. Remove `LIQPAY_PUBLIC_KEY`, `LIQPAY_PRIVATE_KEY` and `LIQPAY_SANDBOX` from the API service once it is running the mono release. The old callback route is retired.

Without the acquiring token the API still starts. The billing screen reports that online checkout is unavailable, and checkout returns HTTP 503. The release does not change the enforcement value, existing clinic entitlements or the landing CTA.

## Prices and the assisted launch (2026-11-19)

- New clinics: Start 1,990 UAH/month + 4,990 UAH one-time launch (first payment 6,980); Pro 4,990 UAH/month + the same 4,990 UAH launch (first payment 9,980; corrected 2026-11-19, the Pro launch includes the standard agent setup within the agreed scope; custom integrations and development are quoted separately). Network and the AI pack are unchanged. Prices live in `apps/api/src/service/plans.ts` (`PLANS`, `LAUNCH_FEE_UAH`).
- Stored renewal price: `Clinic.renewalPlan` / `renewalPriceUah`. Every paid subscription stores the monthly price of its plan; renewals of that plan keep it, another plan uses the list price. Migration `20261119100000_assisted_launch` fills it for clinics already activated before the change (Start 1,990, Pro 3,990), by state, never by name or email. Orders keep their amount snapshot; nothing is recalculated.
- Only a never-activated clinic (no launch paid, no paid period, `AWAITING_PAYMENT`) is charged the launch. Its confirmed payment sets `LAUNCH_PENDING` ("Оплачено · готуємо запуск"): the plan and one prepaid month are recorded, the order has no period yet, setup is allowed, sending to patients and the agent are blocked, a second launch purchase is refused (409 `launch_pending`). A second payment that arrives anyway is recorded as `launch_duplicate` and nothing is granted.
- The service owner starts the month in `/platform` → "Почати оплачений місяць" (`GET`/`POST /platform/clinics/:id/launch`): the dates are shown first; the start is atomic and idempotent, needs a PAID launch payment without any refund, sets one billing month from that moment and records `launchActivatedAt/By` plus the audit `billing.launch_activated`. There is no automatic start.
- A refund of the launch payment before the start: a FULL return cancels the preparation (`billing.launch_cancelled`, the clinic returns to `AWAITING_PAYMENT`, data and settings kept). A PARTIAL return keeps money that the billing model cannot credit to a new purchase, so the clinic stays in `LAUNCH_PENDING` with the billing page showing "support resolves the payment" (`launch.state: REVIEW`, audit `billing.launch_review`, mail to the service owner); no new purchase can be opened and the month cannot be started until the service owner resolves it by hand. No refund is issued automatically; all records are kept. After the start the older rule applies: the paid period is not changed automatically.
- During the preparation an approved agent draft executes nothing (no message, no visit in Cliniccards). The agent can still be checked on real incoming conversations through its drafts (the conversation's "draft" action with the agent switch on), which send nothing; the restricted autonomous test (`AGENT_AUTO_DIALOGS`) stays blocked until the month starts.


- The API stores a local order, amount in UAH minor units, currency, purchase scope and period before issuing the invoice. It sets a 15-minute validity. A repeated click reuses the outstanding purchase in that scope. Start and Pro share the same outstanding subscription slot.
- mono signs the original webhook bytes with ECDSA/SHA-256. The API obtains the bank's public key from `/api/merchant/pubkey` and validates the invoice, amount and currency. It orders updates by `modifiedDate` and grants payment entitlements within the same PostgreSQL transaction as the paid state. The redirect opens a local status page. It carries no proof of payment.
- The return screen and background scheduler reconcile invoices using the status API, including expiry, which normally has no webhook. Following a create timeout the API does not repeat creation. A signed webhook can link the order by its merchant reference. The scheduler can also locate that reference in the merchant statement and confirm the invoice by ID. An empty statement does not prove an unpaid invoice was never issued. An unresolved order remains blocked for operator review.
- For an unresolved order, use the local `BillingPayment.orderId` as the merchant reference. Check it in [mono Business](https://web.monobank.ua/) or with mono support. If they give you the invoice ID, check that the reference, amount and currency agree before linking it through a signed status update or the reconciliation already built into LANKA. If mono confirms no payable invoice exists and there is no payment, record that evidence in the operational ticket and review the order before releasing it. LANKA does not release this case automatically.
- The audit records mismatches, returned amounts, duplicate setup or period payments, and scope changes. An existing paid period or granted allowance is preserved when money is returned. Review these cases with the service owner.

## Test and first live payment

Use mocked API tests or an isolated staging deployment with a dedicated [official test token](https://api.monobank.ua/) in the same server variable. The bank determines test mode from that token. Keep staging on an isolated database, since a successful test invoice grants entitlements in the database configured for that environment.

Production checks confirmed live mono checkout, signed webhook delivery, and Pro fulfillment for 112 Dental. The temporary payment controls have been retired. Historical diagnostic payments remain identifiable as `MONO_DIAGNOSTIC` with their webhook audit evidence. The completed Pro purchase appears in clinic history at the actual amount paid.

For the first authorized live payment, use the intended clinic and verify the price on both screens before paying.

| Purchase | Expected charge |
| --- | --- |
| First Start month | 6,980 UAH (1,990 plus 4,990 setup) |
| First Pro month | 8,980 UAH (3,990 plus 4,990 setup) |
| Clinic renewal after setup | 1,990 UAH for Start or 3,990 UAH for Pro |
| AI pack | 390 UAH for 500 extra replies |
| Two-branch network first month | 12,980 UAH (7,990 plus 4,990 setup), plus 2,990 UAH for each further branch |
| Further branch setup | The branch's saved quote, at least 2,990 UAH |

On return, confirm one paid row for the order in **Settings → Billing** or the network payment status, and match the transaction in the mono cabinet. Verify one additional month for the purchased plan, the bought network period and covered branches, or a single 500-reply credit as applicable. Branch setup records its own fee. Agent autonomy and message sending remain settings controlled by the clinic.

## Recurring payments

Automatic renewal is not implemented. Adding it would require confirming merchant access to mono's regular payments or tokenization product with the bank, collecting and recording explicit payer consent and cancellation terms, implementing authorization and secure token handling if applicable, and reconciling each renewal and cancellation. The acquiring token alone does not enable recurring charges.

[Invoice creation and expiry](https://monobank.ua/api-docs/acquiring/methods/ia/post--api--merchant--invoice--create) · [Invoice status](https://monobank.ua/api-docs/acquiring/methods/ia/get--api--merchant--invoice--status) · [Webhook signature](https://monobank.ua/api-docs/acquiring/dev/webhooks/verify) · [Statement](https://monobank.ua/api-docs/acquiring/extras/statement) · [Brandbook](https://acquiring.monobank.ua/docs/online_acquiring/brandbook) · [Regular payments](https://monobank.ua/api-docs/acquiring/methods/subscription/post--api--merchant--subscription--create)
