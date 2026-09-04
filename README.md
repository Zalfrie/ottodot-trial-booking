# Ottodot — Trial Booking

[![CI](https://github.com/Zalfrie/ottodot-trial-booking/actions/workflows/ci.yml/badge.svg)](https://github.com/Zalfrie/ottodot-trial-booking/actions/workflows/ci.yml)

A working slice of trial-class booking, built around one question: **can two parents end up
confirmed for the same last seat?**

They cannot. Not under a scripted sequence, not under simultaneous requests, and not if someone
bypasses the application and writes to the table directly.

---

## Getting started

**Requirements:** Node 20.11+, and Postgres 14+ (Docker gives you one).

```bash
git clone https://github.com/Zalfrie/ottodot-trial-booking.git
cd ottodot-trial-booking
npm install

docker compose up -d          # Postgres on host port 5433
cp .env.example .env.local    # values already match docker-compose

npm run db:reset              # schema + synthetic seed data
npm run demo:race             # the whole point of the exercise, in one command
npm run test                  # 44 tests
npm run dev                   # http://localhost:3000
```

### Run without Docker

Point it at any Postgres 14+. Create the role and two databases once:

```bash
psql -U postgres -c "CREATE ROLE ottodot LOGIN PASSWORD 'ottodot_dev';" \
                  -c "CREATE DATABASE ottodot_trial OWNER ottodot;" \
                  -c "CREATE DATABASE ottodot_trial_test OWNER ottodot;"
```

Then put the matching URLs in `.env.local` (Option B in `.env.example`) and run `npm run db:reset`.

The schema needs no extensions and no superuser — `gen_random_uuid()` is built into Postgres 13+.

> **What I actually ran:** everything below was verified against a local **Postgres 14.20** on
> Windows with Node 22.22, from a clean `git clone`. I had no Docker daemon on that machine, so
> the `docker-compose.yml` (`postgres:16-alpine`) is written but unverified — it is the standard
> single-service Postgres setup, and nothing in the schema is version-specific beyond Postgres 13.
> If it gives you any trouble, the "Run without Docker" path above is the tested one.

---

## Prove it works

Everything below also runs in CI on every push — against `postgres:16-alpine`, which is how the
containerised path gets verified even though I could not run Docker locally. See
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) and the Actions tab.

### `npm run demo:race` — the required scenario, end to end

Resets the database and runs four acts against the real domain code, asserting as it goes:

| Act | Scenario | Asserted |
|---|---|---|
| 1 | The brief, verbatim: A holds the last seat, B pays first, A then pays | B confirmed, A refused, **A never charged**, class at 4/4 |
| 2 | The same race, both `Pay` calls fired simultaneously | Exactly one confirmed, exactly one refused |
| 3 | Five parents stampede an empty 4-seat class at once | Exactly 4 confirmed, 1 refused |
| 4 | Declined card, then a retry, then a duplicate attempt | Not on the roster, seat released, retry works, duplicate rejected |

It exits non-zero if any assertion fails, so it doubles as a smoke test.

### `npm run test` — 44 tests

```
tests/last-seat-race.test.ts   the required scenario, plus 25-way concurrency
tests/invariants.test.ts       duplicates, capacity, and the DB constraints themselves
tests/payment.test.ts          failure, retry, double-click, cancellation
tests/expire-holds.test.ts     the background reaper
```

Tests run against `TEST_DATABASE_URL`, a **separate database**, so they never disturb what you are
demoing in the browser.

Every scenario ends with `expectInvariantsHold()`, which re-checks the whole database — not just
the values the test happened to return. Counter drift cannot hide.

### `npm run db:check` — reconciliation

Runs those same invariant checks against a live database. In production this is what you would
wire to an alert.

### By hand, in the browser

1. `npm run dev`, open <http://localhost:3000>
2. Pick **Zara**, pick **Fractions Bootcamp** (badged *Last seat*), choose `slow_success`, click
   *Start checkout*. **Do not pay yet.**
3. In a second tab, do the same for **Omar** on the same class with `success`.
4. Pay in tab 2 → confirmed. Pay in tab 1 → *"Someone else took the last seat"*, and the Payment
   attempts table is **empty**: that card was never charged.
5. <http://localhost:3000/admin> shows exactly 4 students.

---

## What I built

- A parent picks a child and a trial class, starts checkout, and pays through a mock gateway.
- Booking status is shown after submission, with every payment attempt listed.
- `/admin` is the teaching team's roster; the same data is at `GET /api/admin/rosters`.
- A background reaper reclaims seats from checkouts that died mid-charge.

Deliberately **not** built: regular enrolment, auth, real payments, emails, waitlists.

---

## Backend design

### Data model

```
parents ─┬─< students ─┬─< bookings >─┬─ trial_classes
         │             │              │    capacity     (4)
         │             │              │    seats_taken  (denormalised counter)
         │             └─< payment_attempts
```

Five tables, in `db/schema.sql`. The load-bearing parts:

| Column | Why it exists |
|---|---|
| `trial_classes.capacity` | 4 for every trial class, but a column, not a constant. |
| `trial_classes.seats_taken` | Lets "take the last seat" be **one atomic statement** that row-locks exactly one row. |
| `bookings.status` | The state machine below. |
| `bookings.seat_held_at` | When the seat was reserved. The reaper finds crashed checkouts with it. |
| `bookings.cancellation_reason` | Machine-readable: `class_full`, `payment_failed`, `abandoned`, `stale_seat_hold`, `requested_by_parent`. |
| `payment_attempts` | Append-only. A booking can have several — a decline then a retry. |

### Booking statuses

| Status | Holds a seat? | On the roster? | Meaning |
|---|---|---|---|
| `pending_payment` | **no** | no | Checkout started. Nothing reserved. |
| `processing_payment` | **yes** | no | Seat reserved, card being charged. Transient. |
| `confirmed` | **yes** | **yes** | Paid. |
| `payment_failed` | no | no | Declined; seat released; retryable. |
| `cancelled` | no | no | Closed — lost the last-seat race, or the parent cancelled. |
| `expired` | no | no | Abandoned; reaped by the background job. |

```
                  ┌──────────────── class_full ──────────────► cancelled
                  │
pending_payment ──┴─ seat won ─► processing_payment ─┬─ paid ────► confirmed
      │                                              └─ declined ► payment_failed ──┐
      │                                                                 ▲           │
      └── abandoned (job) ─► expired                                    └── retry ──┘
```

### API

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/classes` | Classes with live availability |
| `GET` | `/api/parents` | Parents and their children |
| `POST` | `/api/bookings` | Create a `pending_payment` booking. **No seat reserved.** |
| `GET` | `/api/bookings/:id` | Status + payment attempts |
| `POST` | `/api/bookings/:id/payment` | **Reserve the seat, then charge.** |
| `POST` | `/api/bookings/:id/cancel` | Cancel, releasing any seat |
| `GET` | `/api/admin/rosters` | Every roster |
| `GET` | `/api/admin/classes/:id/roster` | One roster |
| `POST` | `/api/admin/expire-holds` | Run the reaper on demand |

`POST /api/bookings/:id/payment` returns **200** with an `outcome` of `confirmed`,
`payment_failed` or `class_full`. Losing the race is a legitimate business outcome of a
well-formed request, not a client error — the UI branches on `outcome`, and errors
(`{ error: { code, message } }`) stay reserved for genuinely bad requests.

---

## The last-seat race

### The approach

**Reserve the seat, then charge the card.** In that order, always.

```
TX1   lock the booking row
      UPDATE trial_classes SET seats_taken = seats_taken + 1
       WHERE id = $1 AND seats_taken < capacity     ← the whole race, in one statement
      ├─ 0 rows → booking = cancelled/class_full, STOP. The card is never touched.
      └─ 1 row  → booking = processing_payment
──    call the payment provider, holding no locks
TX2   success  → confirmed
      declined → release the seat, booking = payment_failed
```

Walking the brief's scenario through it:

1. **A** selects the last slot → `pending_payment`. `seats_taken` is still 3.
2. **B** selects the same slot → also `pending_payment`. Still 3.
3. **B** pays → the `UPDATE` matches (3 < 4), `seats_taken` becomes 4, B is `confirmed`.
4. **A** pays → the `UPDATE` matches **zero rows** (4 is not < 4). A is `cancelled/class_full`,
   and A's card is never contacted.

### Why that statement is enough

`UPDATE … WHERE seats_taken < capacity` takes a row-exclusive lock on exactly one row. Two
checkouts for the same class serialise on it; two for *different* classes never touch each other.

The subtle part is that under `READ COMMITTED` — Postgres' default — a blocked `UPDATE` does not
simply proceed once the lock frees. It re-reads the now-committed row and **re-evaluates the
`WHERE` clause against it** (`EvalPlanQual`). So the loser genuinely sees `seats_taken = 4` and
matches nothing. There is no lost update, and no need for `SERIALIZABLE` or an advisory lock.

`tests/last-seat-race.test.ts` doesn't take my word for it: 25 parents stampede one 4-seat class
simultaneously, and exactly 4 are confirmed.

### Why the database still gets the final say

```sql
CONSTRAINT trial_classes_seats_within_capacity
  CHECK (seats_taken >= 0 AND seats_taken <= capacity)
```

If my reasoning above is ever wrong, or a future endpoint increments the counter without that
`WHERE` clause, the transaction **aborts** rather than overbooking a class. Two tests write to the
table directly, bypassing all application code, and assert the database refuses.

### Why `pending_payment` does not hold a seat

The obvious alternative is a timed hold at checkout: A reserves the last seat, B is told the class
is full before reaching payment.

I chose not to, and the trade-off is deliberate:

- **A held seat needs a reaper to be correct.** Every abandoned checkout — closed tab, dead phone
  battery — silently removes capacity until a job reclaims it. That makes the background job
  load-bearing for revenue, not just hygiene. With this design the reaper only covers a *crash
  mid-charge*, and if it never ran, nothing would be oversold; a few seats would leak.
- **Trial classes have 4 seats, not 4,000.** One abandoned hold is 25% of a class. At Ottodot's
  scale, protecting real conversions from phantom holds is worth more than sparing the loser a
  late "class full" message.
- **Nobody is charged for a seat that does not exist,** so there is no refund path at all. That is
  a stronger guarantee than "hold it and refund if something goes wrong".

What the loser pays for it: a worse message, later in the flow. If that mattered, I would add a
short hold (60–90s) *on top of* the atomic check — the hold would improve the UX, and the check
would still be what makes it correct.

### Duplicate bookings

```sql
CREATE UNIQUE INDEX bookings_one_active_per_student_class
  ON bookings (student_id, trial_class_id)
  WHERE status IN ('pending_payment', 'processing_payment', 'confirmed');
```

The index is **partial**, which is what makes it right rather than merely strict: a parent whose
payment failed, or who cancelled, is free to book that class again, because those rows fall
outside it.

The application catches the resulting `23505` and returns a friendly `409 DUPLICATE_BOOKING`, but
the index is what guarantees it. A test fires eight identical "Book" requests simultaneously;
exactly one row is created.

One ordering detail worth naming: the duplicate check runs **before** the capacity check. A parent
whose child is already confirmed on a class that has since filled up would otherwise be told "this
class is full" — true, but useless, because their child has a seat. `DUPLICATE_BOOKING` is the
answer that tells them something they can act on.

### Payment failure

A declined card releases the seat and records the attempt **in the same transaction**, so a
failure can never leave a child holding a seat. The booking becomes `payment_failed` — outside the
unique index — so the parent can retry on the same booking, and each attempt is appended to
`payment_attempts`.

If the class filled up while they were finding another card, the retry is refused with
`class_full` and, again, no charge.

### Where each check lives

| Layer | Checks | Why there |
|---|---|---|
| **UI** | Hides full classes; disables Pay unless payable | Cheap, friendly. Trusted for nothing. |
| **Backend** | UUID shapes, existence, state machine, advisory capacity check | Good errors, no wasted provider calls. Still racy by nature — which is why it is not the last word. |
| **Database** | `CHECK (seats_taken <= capacity)`, the partial unique index, `CHECK` tying `seat_held_at` to status, the atomic `UPDATE` | The only layer that survives concurrency and future code. |
| **Background job** | Reclaims seats stranded by a crash mid-charge; expires abandoned checkouts | Nothing else can clean up after a process that died between two transactions. |

The rule I followed: **the UI is a convenience, the backend is a filter, the database is the
truth.** Every invariant that matters is stated at least twice, and at least once in SQL.

---

## Assumptions

- One parent per child, and no auth — the parent list stands in for a session. Adding auth changes
  who may act, not what is correct.
- Trials are paid up front. Free trials would remove payment but not the race.
- Capacity is 4 for every class, but stored per class.
- The mock gateway's outcome is caller-supplied (`success` / `failure` / `slow_success`). A real
  one would use the idempotency key that is already threaded through `charge()`.
- Provider webhooks are out of scope; the charge is treated as synchronous.
- Times are `timestamptz`; the UI renders in the viewer's locale.

## Time spent

~3.5 hours: ~30m reading and designing the schema, ~1h15m domain logic and the race handling,
~1h tests and the demo script, ~45m UI and this README.

## What I deliberately cut

- **Auth and authorisation.** `/admin` is open. It is a demo, and auth is orthogonal to the
  invariants being graded.
- **Waitlists.** The natural next feature once a class is full, and a distraction from correctness.
- **A migration tool.** `db/schema.sql` is rebuilt from scratch; there is no `002_…` yet. For a
  second engineer I would add one before the second schema change, not before the first.
- **Real payments and webhooks.** The gateway interface is the seam; swapping it is a one-file job.
- **Frontend polish.** Hand-written CSS, no component library. The brief said it would not be
  graded, so I spent the time on tests instead.
- **A scheduler.** The reaper is a script and an endpoint, not a cron container.

## What I would monitor after release

Ordered by how badly I would want to be paged:

1. **Invariant violations** — `npm run db:check` on a schedule. Any non-zero result is a page:
   it means the counter drifted or a constraint was dropped.
2. **`class_full` outcomes per class** — the count of parents who lost a race. A spike means the
   pending-payment design is costing real conversions, and the timed hold I skipped becomes worth
   revisiting.
3. **Bookings stuck in `processing_payment`** — should be near zero and short-lived. A rising
   count means checkouts are dying mid-charge.
4. **Seats reclaimed by the reaper per run** — should be ~0. Anything else means crashes.
5. **Payment decline rate**, split by reason, to tell "our bug" from "their bank".
6. **Time from `pending_payment` to a terminal state** — the checkout funnel, and an early warning
   that the provider is slow.
7. **Rosters at class start** — the business outcome. Any class over 4 is a sev-1 by definition.

## What I would do next

1. **Idempotency keys on `POST /api/bookings`**, so a retried request from a flaky mobile network
   returns the original booking instead of a `409`. The double-click case is already safe; the
   *network* retry case returns a confusing error.
2. **Provider webhooks**, so a charge that succeeds after our process dies still confirms the
   booking, instead of the reaper expiring a booking the parent genuinely paid for. This is the
   one real correctness gap left, and it is why the reaper's timeout is 5 minutes rather than 30
   seconds.
3. **Auth**, and scope every query by the signed-in parent.
4. **A waitlist**, fed by the `class_full` and cancellation paths.
5. **A migration tool** before the second schema change.
6. **Load-test the reaper's `UPDATE … FROM` join** on a class with a long booking history.

---

## Project layout

```
db/schema.sql                     tables, constraints, the availability view
db/seed.sql                       synthetic data covering the four required cases
src/lib/booking/seats.ts          the atomic seat acquire/release — the crux
src/lib/booking/pay-booking.ts    reserve-then-charge, in three transactions
src/lib/booking/create-booking.ts pending booking + duplicate handling
src/lib/booking/expire-holds.ts   the background reaper
src/lib/booking/invariants.ts     the properties, shared by tests and db:check
src/lib/payments/gateway.ts       mock gateway behind a swappable interface
src/app/api/…                     route handlers
src/app/…                         parent flow, booking status, admin roster
scripts/demo-last-seat-race.ts    the four-act demo
tests/…                           44 tests
```

## Seed data

`npm run db:reset` loads four classes covering every case the brief asks for:

| Class | State | Demonstrates |
|---|---|---|
| Forces & Motion | 0/4 | A class with available seats |
| **Fractions Bootcamp** | **3/4** | **Exactly 3 confirmed — the last-seat race** |
| The Human Body | 4/4 | A full class |
| Speed & Ratio | 1/4 | Zara confirmed (duplicate attempt) and Omar `payment_failed` (retry) |

IDs are fixed and exported from `scripts/reset-lib.ts`, so the tests, the demo and this README all
point at the same rows.
