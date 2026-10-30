# The patient funnel: how it works and what we can build

A document for the project owner and the clinic owner. The numbers come from real data of the clinic 112 dental on 2026-10-28 (aggregates only, no names).

## 1. What a funnel is in plain words
A funnel shows the **patient's path through stages** and **how many people drop off at each step**. Not "how many patients in total", but "of 100 people who contacted us, how many reached an appointment, a treatment plan, payment, a return visit".

Four ideas hold it together:
- **Stage:** an event that can be checked in the data (card created, booked, came, got a plan, started treatment, paid, returned).
- **Conversion:** the share that moved from a stage to the next (of 100 booked, 71 came: conversion 71%). The most important number of a funnel is **the place with the biggest loss**: that is where the money is.
- **Cohort:** a group of people who entered at the same moment (for example "cards created in September"). A funnel is counted **by cohort**, otherwise the numbers lie: someone who came yesterday could not have reached the end of the path yet, so they cannot be counted as "lost".
- **Time between stages:** how many days pass from booking to arrival, from a plan to the start of treatment. If someone is stuck longer than usual, it is time to bring them back.

Dentistry has two funnels:
1. **Acquisition** (before the first treatment): inquiry → booking → came → plan → started treatment → paid.
2. **Retention** (after): first visit → finished treatment → came back for prophylaxis → regular patient / gone.
A feature of dentistry: treatment is long and expensive, so the main losses are not at "booking" but at **agreeing to the plan** and at **unfinished treatment**.

## 2. What data we have (verified on a live clinic)
| What | Where from | How we use it |
|---|---|---|
| Card creation date | every patient (filled for 100%) | entering the funnel, the cohort |
| Dates of the first, last and next visit | patient card | stages "came", "returned" |
| When a booking was created and when the visit is | visit: `date_created`, `visit_start` | time "booking → arrival" |
| Result of a booking (came, cancelled, no-show, rescheduled) | visit status | losses at the step "booking → arrival" |
| Treatment plans and item completion | plans, items, amounts | stages "got a plan", "started treatment", "finished" |
| Payments | payments, patient balance | stage "paid", money along the funnel |
| Inquiry source | card (field "How did you hear") | funnel by sources |
| Patient statuses | the clinic's reference | "New", "In diagnostics", "Refused treatment", "Finished treatment", directions (Implantation, etc.) |
| Reminders | staff reminders | "someone already remembers this patient" |
| Result of a call | our contact log | effectiveness of bringing patients back |

**What Cliniccards does not have:** the very top of the funnel (calls, Instagram messages, ad requests before a card exists) and the booking channel (all appointments are created by one shared profile). The inquiries journal and the messaging module close this gap.

## 3. A trial funnel on your data
Cohort: **858 cards created in the last 12 months.**

| Stage | Patients | From the start | From the previous stage |
|---|---|---|---|
| Card created | 858 | 100% | |
| Booked | 826 | 96% | 96% |
| Came (the visit took place) | 589 | 69% | 71% |
| Got a treatment plan* | 589 | 69% | 100%* |
| Started treatment | 522 | 61% | 89% |
| Paid something | 491 | 57% | 94% |
| Came 2+ times | 246 | 29% | 50% |
| Visited in the last 90 days | 251 | 29% | |

Time: card → booking **1 day**, booking → arrival **2 days**.

**Where the 269 people who did not reach an appointment are lost:**
- 93: the last booking is cancelled;
- **108: a booking in the past was never closed** (statuses "Planned" 83, "Confirmed" 25, "Not confirmed" 1): the administrator did not mark whether the person came;
- 32: no booking at all (a card without a booking);
- 17: booked, the appointment is still ahead;
- 14: did not come; 4: rescheduled.

### What follows
1. **The main loss is at the step "booked → came": 29% did not come.** But almost half of them (108) are not losses, they are **unclosed bookings**: it is unknown whether the person came. Until they are closed, the funnel understates arrival. So the list "past bookings without an outcome" is needed before the funnel, not after.
2. **The stage "got a plan" does not work now:** 589 = 589, because for everyone who came, the plan contains at least the first appointment (a consultation). "Treatment plan" must be defined otherwise: for example a plan with services other than a consultation or diagnostics, or a plan sum above a threshold. The clinic owner decides.
3. **The source is not filled for everyone: for 39% of the cohort's cards it is empty, and their conversion to arrival is 44%, while for the rest it is 80–87%.** Most likely the source is entered on arrival, so "empty source" = "did not come". Comparing channels by these numbers is premature: the source has to be recorded when the card is created.
4. **Good news:** 89% go from arrival to the start of treatment and 94% of those who started pay. The clinic sells treatment well. The second weak step: **only 50% return** (a second visit).
5. Patient statuses in Cliniccards are maintained rarely ("Refused treatment" 50, "Finished treatment" 156, "New" 181), and the status "Technical laboratory" is set for 81% of patients, so a funnel cannot be built on statuses. Stages are better computed from visits, plans and payments than from statuses.

## 4. What can be built
### Level 1: the "Funnel" page (from data we already have)
- A choice of period and cohort (cards created in a month, a quarter, a year).
- 8 stages: count, conversion from the start and from the previous stage, median days between stages.
- Filters: source, treatment direction (by service groups), status.
- **The main thing: a click on a step opens the list of specific people who are stuck there** (for example "booked 3+ days ago and did not come", "got a plan 30 days ago and did not start treatment"). A button "create tasks for the administrator".
- A separate list "bookings without an outcome" as the condition of accuracy.

### Level 2: dynamics and causes
- **A cohort table:** each row is a month, the columns show what share of the month reached each stage and how many returned after 3, 6, 12 months. It shows whether the work got better or worse.
- **Causes of loss:** cancellation, no-show, an unclosed booking, refusal of treatment (status), did not start, stopped midway.
- Comparison of directions (implantation, prosthetics, therapy) by path length and share who finished.

### Level 3: money
- The funnel **in hryvnia:** the sum of plans → started → paid → not performed. How much money is stuck between a plan and treatment, and whose.
- Average check and time to payment by stage; lost revenue from unfinished treatment (already visible for you: 377 patients, 16.9 million UAH).

### Level 4: the top of the funnel and advertising (needs new data)
- Inquiries (calls, Instagram messages, Google) → card: needs the messaging module or manual registration of inquiries by the administrator in one tap.
- Cost of acquisition and payback of channels: needs ad spend by month (entered by hand or uploaded from Excel).
- The administrator's performance: call → booking → arrival (the contact log already exists).

## 5. What to prepare first
1. **Extend history storage:** visits were stored for the last 180 days; the funnel needs 2–3 years; also the dates of card creation, first and next visit.
2. **Close past bookings** (a list for the administrator).
3. **Agree on definitions** (section 6).
4. Ask administrators to **fill the source when creating the card**, not on arrival.

## 6. Decisions of the clinic owner
1. ✅ "Got a treatment plan": decided on 2026-10-28 to count any plan, as now. Since for everyone who came the plan contains at least the first appointment, the stage coincides with "came" and is **removed from the funnel**. Funnel stages: card → booked → came → started treatment → paid → returned (2+ visits) → active (a visit in the last 90 days).
2. What counts as "started treatment": any completed plan item other than a consultation?
3. After how many days without a visit a person is "gone": 180? 365? After how many days after a booking without arrival "lost": 7? 14?
4. Which slices are needed first: sources, directions, months, administrators?
5. Whether to count the "top of the funnel" (inquiries before a card is created) and how they are recorded now.

## 7. Order of work
1. ✅ Done 2026-10-28: the report "Bookings without an outcome" (with a weekly chart and a card on the home page) and 3 years of visit history, plus the dates of card creation and first visit. On clinic data: 325 bookings without an outcome in 90 days (39 in the current week), 1308 in a year.
2. ✅ Done 2026-10-28: the page "Аналітика" (patient funnel): two funnels (path to treatment and return), "where we lose" with lists of people, cohorts by month (a heat map), comparison by sources and directions. Definitions: "gone" = 180 days; "came" = a visit "was", or a completed service, or a payment; "started treatment" = a therapeutic service was completed (not examination, check-up, prophylaxis, materials, sedation). A slice by administrators is impossible for now (all appointments are created by one shared profile).
3. ✅ Dynamics and cohorts (level 2) are on the "Аналітика" page.
4. ✅ The top of the funnel: the inquiries journal (page "Звернення"): the administrator enters a call, message or request in one tap; an inquiry links itself to a card by phone; "Аналітика" has a block "Inquiry → visit" split by channel. Automatic intake of inquiries from messengers arrives with the chat inbox (Telegram done; Instagram next).
5. ✅ Done 2026-10-29: results of messages in the funnel page (replied within 7 days, booked within 14 days, came; a coincidence in time, not proof of cause).
6. Next: money in the funnel (level 3) and advertising (spend per channel → the cost of a patient and payback).
