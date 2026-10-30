# Cliniccards API

Source: the full documentation (Postman) published at https://cliniccards.com/api. It is public but rendered by scripts; the machine-readable collection is `https://documenter.gw.postman.com/api/collections/29513893/2s9YBxZbqY?segregateAuth=true&versionTag=latest`. Read in full (methods, parameters, sample responses). Several behaviours below were then checked on a live clinic (112 dental); those are marked "verified on a live clinic".

## General
- Base address: `https://cliniccards.com/api/...`
- Headers on every request: `Token: <API key>` and `Content-Type: application/json`.
- Only the clinic owner can create a key: Settings → Other → Clinic settings → API key. One key gives access to the whole clinic; its rights cannot be limited. (A key that leaked once was replaced; keep keys only in encrypted storage.)
- **Limit: 60 requests per minute.** Everything we build must respect this.
- Response format: `{"data": ..., "result": "success"|"fail", "error": "..."}`. The HTTP status does not always show an error: check `result`.
- Dates in requests are `YYYY-MM-DD`; in responses `YYYY-MM-DD HH:MM:SS` (clinic time zone, read as Europe/Kyiv). Money and IDs arrive as strings (IDs sometimes as numbers: normalise when parsing).
- Pagination only for patients (`limit`, `offset`) and treatment stages. Other methods work by a `from`/`to` period.
- There are no webhooks, so sync is polling only. There is no "changed since" filter; visits have `date_edited` but you cannot select by it, only by period.

## Methods

### Schedule
| Method | What it gives |
|---|---|
| GET `/visits?from&to` | Visits: `visit_id`, `patient_id`, `status`, `doctor_id`, `visit_start`, `visit_end`, `cabinet_id`, `note`, `date_created`, `date_edited`, `created_by`, `price_items[]` (services and prices) |
| POST `/visits` | Create a visit: `status, patient_id, cabinet_id, doctor_id, note (1–400, required), date, time_start, time_end` (multiples of 5 min), `price_items_ids` |
| PUT `/visits` | Change a visit (same fields + `visit_id`, all required) |
| DELETE `/visits` | Delete a visit: **do not use** (to cancel, set the status CANCELLED) |
| GET `/schedule-shifts?from&to` | Doctor shifts per cabinet: `doctor_id`, `schedule_cabinets_id`, `shift_start`, `shift_end` |
| GET `/schedule-settings` | Working days and hours, holidays, `min_free_time` |
| GET `/schedule-spaces?from&to` | Reserved time blocks (grey blocks in the schedule: breaks and "do not book here") |

Visit statuses: `PLANNED, CONFIRMED, NOT_CONFIRMED, VISITED, MOVED, DID_NOT_COME, IN_CLINIC, BOOKING, CANCELLED, IN_CHAIR`.

Free windows = doctor shifts − visits − reserved blocks, inside working hours. We compute them ourselves.

### Patients
| Method | What it gives |
|---|---|
| GET `/patients?limit&offset` | Patients: `patient_id, lastname, firstname, source, phone, phone2, email, gender, birthday, curator_id, date_created, preferred_contact, statuses[], balance_paid, balance_issued, last_visit_date, important_note, note, code`, etc. |
| GET `/patients/{id}` (several comma-separated), GET `/patients?phone=` | Search by ID and phone |
| POST `/patients`, PUT `/patients/{id}` | Create and change (the `source` field is the inquiry source) |
| DELETE `/patients` | **Never use** |

The card has the inquiry source, the preferred contact channel (`preferred_contact`), balances and the last visit date. There is no marketing consent field: we keep consent ourselves.

### Treatment plans (read only)
- GET `/plans?from&to`: `plan_id, plan_name, doctor_id, plan_total, plan_total_done, stages_list`, and the totals with discount `plan_total_with_discount`, `plan_total_done_with_discount`.
- GET `/planItems/{status}?from&to`, statuses `NEW, PLANNED_TO_DO, DONE, INVOICED`: plan items with `patient_id, plan_id, name, price, price_group_name, status, done_by_doctor_id, marked_done_date, date_invoiced, paid`.
- GET `/planItems/invoiced?from&to`.
- Unfinished treatment: plans where `plan_total_done < plan_total` or there are `NEW/PLANNED_TO_DO` items. With the "simple" financial model DONE is replaced by INVOICED.

### Treatment history (text)
- GET `/stages/` (`limit`/`offset` by patients), GET `/stages/{patient_id}`: stages and comments (HTML).
- POST `/stages/{patient_id}`: add a stage with comments (`name`, `created_by_id` = doctor_id from Staff, `comments[]`). Could be used to write contact history into the card.

### Patient and clinic finance
- Read: GET `/prices` returns rows `{group_id, group_name, group_color, item_id, item_name, item_code, item_additional, item_price}` (verified on a live clinic, 2026-10-30, read only: 234 items in 16 groups for 112 dental; prices are strings, there is no currency field while the Cliniccards price page lets a currency be chosen per item, a price "0" means not set (20 items), names carry HTML entities such as `&#34;` (11 items), `item_additional` holds what the service includes (41 items)). Also: GET `/payments`, `/invoices`, `/receipts` (by period), `/deposits-list/{patient_id}`, `/cash-desks`, `/spendings`, `/cash-flow-operations`.
- Write (**do not use**): POST `/receive-patients-payment`, `/invoice/`, `/save-deposit`, `/spendings/`.

### Clinic structure (read)
GET `/staff` (`doctor_id, role: MANAGER/DOCTOR/…, phone`), `/cabinets`, `/sub-clinics` (branch labels, their `id` is the `subclinic_id`), `/clinic-profile`, `/patientStatuses`, `/insurance-companies`.

### Operations (tasks and waiting list)
- GET/POST/PUT `/reminders`: **reminders are tasks for staff**. Fields: `date`, `note`, `patient_id`, `executor` (`ALL`, `MANAGER`, `DOCTOR`, `ASSISTANT`, `ADMINISTRATOR`, `OTHER` or a user ID), `status` (1 NEW, 2 DONE, 3 CANCELLED, 4 MOVED), `priority` (1/2). This would solve "create tasks in Cliniccards".
- GET/POST/PUT `/waitings`: the waiting list. `status` 1 NEW, 2 SCHEDULED, 3 CANCELLED; fields `patient_id, doctor_id, note, subclinic_id`.

### Online booking and stock
- GET `/booking-settings`, `/booking-items` (specialists and services available in online booking; despite the name this is not a list of incoming requests).
- GET `/stock-products`, `/stock-invoices`, POST `/stock-invoice`: stock, not needed yet.
- GET `/files/{patient_id}`, `/file?name=`: patient files.

## What this means for the product
| From the plan | Possible? |
|---|---|
| "No next visit after a procedure" report | Yes: `visits` + `patients` (`last_visit_date` exists) |
| No-shows, cancellations, reschedules | Yes: statuses `DID_NOT_COME, CANCELLED, MOVED` |
| Unfinished treatment | Yes: `plans` + `planItems` |
| Consultations without continued treatment | Partly: needs services in `price_items` and the clinic's rules |
| Finance: payments, debt, by doctor and service | Yes: payments, invoices, the patient's `balance_issued` |
| Inquiry sources | Yes: the patient's `source` |
| Tasks for the administrator | Yes: `reminders` in Cliniccards or our own tasks |
| Waiting list, filling cancellations | Yes: `waitings` + free-window calculation |
| Booking, reschedule, cancellation | Yes: POST/PUT `visits` (only with staff confirmation); **not enabled by us** |
| Linking messenger inquiries to a card | Yes: search by phone |
| Free windows | We compute them from shifts and visits |
| Real time / webhooks | No, polling only |
| Marketing consent | Not in the API; we store it |
| Contact results (reached / refused) | Not in the API; ours, optionally a stage in the card |
| Who created a visit (per administrator) | Not usable: on the first clinic all visits are created by one shared profile |

## Constraints for the architecture
1. **60 requests per minute per key.** The first load of a large clinic is slow and paged; sync runs in the background with a request queue and retry. Each clinic has its own counter.
2. **No "changed since".** Incremental sync works by window: periodically re-read visits for the last N days and the next M days, and patients in full once a day (by `limit/offset`). A deleted visit shows up only as missing when the window is re-read.
3. **A method whitelist in the connector.** Only read (GET) methods are allowed now. Writing would be added one method at a time (`POST/PUT /visits`, `/reminders`, `/waitings`, `POST /stages/{id}`) and only on an explicit staff action. Forbidden: `DELETE *`, payments, invoices, deposits, spendings, stock.
   **Write support (2026-10-29, built on the mock, NOT verified on a live clinic):** `apps/api/src/booking/` (explicit staff action, unique key per write, fresh check of the place, lost answers are reconciled instead of repeated), `CliniccardsClient.post/put` for `/visits` and `/patients` only. Two server keys: `CLINICCARDS_WRITE_ENABLED=true` and, for the real address, `CLINICCARDS_WRITE_LIVE=true`; plus the clinic flag `bookingWriteEnabled` set by the service owner. To verify together with the owner: the `status` a new visit accepts (`VISIT_STATUS` in `cliniccards.connector.ts`), whether `doctor_id` is required, the shape of the POST answer, whether PUT needs `price_items_ids`, the `phone` filter of GET `/patients`, how a cancelled visit looks afterwards. Older note:
   **Write draft (2026-10-28):** `CliniccardsClient.post` (only `/visits`, disabled unless the server sets `CLINICCARDS_WRITE_ENABLED=true`), `CliniccardsConnector.createVisit`, the `CreateVisitRequest` type in `connector.ts`. Before turning it on: verify on a live clinic the value of `status` for a new visit, whether `doctor_id` is required and what the method returns; wire it to the AI setting "create appointments itself" (`BOOKING_WRITE_SUPPORTED` in `ai.service.ts`); add tests against the mock; get the owner's explicit permission.
4. **The key** is stored encrypted; never log the `Token` header.
5. **Visit statuses** are stored as they are (10 values), not collapsed to 4: the no-show and reschedule reports depend on them.
6. Money arrives as strings and IDs as strings and numbers mixed: normalise while parsing.

## What the code uses, and assumptions (check on a live clinic)
The connector reads: `/patients` (paged), `/visits`, `/planItems`, `/payments`, `/invoices`, `/schedule-shifts`, `/schedule-spaces`, `/staff` (key check), `/cabinets` (cabinet names), `/plans`, `/reminders` (GET with `from`/`to`, from today up to a year ahead), `/clinic-profile` (logo).
- Reminders: the reports "no next visit", "lapsed" and "unfinished treatment" hide patients who have an active NEW reminder (a decision of the clinic owner).
- Free windows: if Cliniccards has doctor shifts (`/schedule-shifts`) we compute per doctor; if not (the first clinic has doctor profiles for only some doctors) we use the clinic's working hours set in our Settings (`Clinic.workHours`, default 09:00–20:00 every day), minus the visits of the cabinet and the grey blocks (`/schedule-spaces`).
- Plan totals: the currency is the clinic's main currency with a fixed rate per plan; the remaining treatment is computed from `plan_total_with_discount − plan_total_done_with_discount`, because plan item prices may be in another currency and neither the item nor `/prices` carries a currency field (verified on a live clinic).
- `/planItems` and `/plans` are filtered by the creation date (`date_created`), so we read three years (verified on a live clinic).
- Dates without a time zone are read as clinic time (Europe/Kyiv, `apps/api/src/common/clinic-time.ts`).
- Load speed (verified on a live clinic, 2026-10-28): a 3-year period and `limit=5000` for patients are accepted in one request (25 thousand plan items in 1.9 s), so the connector reads yearly chunks and pages of 1000 (about 20 requests per load instead of 120). If a large period fails with a request error, it falls back to 31-day chunks and reads pages until an empty one. Loading 3,500 patients takes about 30 seconds.
- Birth dates (`birthday`) are synced into `Patient.birthDate` for the birthday scenario.
- Checked only against the mock (`apps/api/mock`), which was written from this documentation: other fields and the exact shape of real responses.

Assumptions not covered by the documentation:
1. **Which date field filters the period.** We assume `date_created` for `/planItems` and `/invoices`, and `date` for `/payments`. If it is different, plan items created long ago but done recently may be missing from a load. Check this first on every new clinic.
2. **The maximum request period** and the response size.
3. **Time zone.** Dates without a zone are stored as they are (as UTC), wall-clock time of the clinic. Comparing with "now" gives a few hours of error; code that needs correctness uses the clinic-time helpers.
4. **The meaning of `balance_issued` and `balance_paid`** on the patient card: debt is "issued minus paid".
5. **Deleted visits.** A visit deleted in Cliniccards disappears here at the next sync (inside a window of 180 days back and 90 forward). If the API returns deleted visits with some status, that must be handled.

## Still unknown (check on clinic data)
- Real responses: presence of all fields, volumes, duplicate patients.
- How the clinic uses `source`, patient statuses and the financial model (SIMPLE/STANDARD).
- Where they keep notes and contact results with patients.
- Several sub-clinics: a `subclinic_id` filter is not visible on read methods.
