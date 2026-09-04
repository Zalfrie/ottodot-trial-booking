# AI usage

## Which tools

**Claude Code (Opus 5)** in the Claude desktop app, for the whole build. No other AI tools.

I worked in one long session, driving it file by file rather than asking for "a booking system"
and accepting whatever came back.

## What I used it for

| Used it heavily | Kept it away from |
|---|---|
| Scaffolding — `package.json`, `tsconfig`, route handlers, the CSS | The concurrency strategy |
| Writing out the test scenarios once I had decided what to assert | The status set and what each status means about a seat |
| The demo script's structure and output formatting | The decision that `pending_payment` reserves nothing |
| Prose passes over this README | The ordering of "reserve, then charge" |
| Catching the mechanical stuff — a missing `updated_at`, an unused import | |

The split is deliberate. The parts that are graded — the data model, the invariants, the ordering
of operations — are decisions, and I wanted to be able to defend each one. The parts that are
typing, I delegated.

## Where AI moved me faster

**The test suite.** Once I had settled the design, I described each scenario in a sentence —
"25 parents stampede a 4-seat class simultaneously, assert exactly 4 confirmed and that none of
the losers has a payment_attempt row" — and got a working test back. Then the shape of the first
few made the rest almost free.

That is roughly an hour saved, and it went straight back into coverage: the `slow_success`
mid-flight assertions, the double-click test, and the reaper's multi-class case all exist because
writing them was cheap. A thinner suite would have been the honest 4-hour outcome without it.

**Second place: dependency hygiene.** It scaffolded `next@15.5.4`, which npm immediately flagged as
carrying a published CVE. Rather than take the one-line bump and move on, I had it break the audit
down by *which* advisories were reachable from a direct dependency, then took the whole set in one
pass — Next 16.3.4, Vitest 3.2.7, tsx, pg, `@types/node`. `npm audit` now reports **0
vulnerabilities**, and `npm run typecheck`, `npm run build`, `npm test` and `npm run demo:race` all
pass on the upgraded stack. That is maybe fifteen minutes of work I would probably have skipped
under a 4-hour clock on my own.

## Where I disagreed with it

**The seat hold.** The first design it proposed reserved the seat at `POST /bookings`, so a
`pending_payment` booking held capacity for 15 minutes. It is the conventional answer — it is how
event ticketing works — and it makes the race trivially impossible, because User B is turned away
before reaching payment.

I rejected it. The reasoning is in the README under *Why `pending_payment` does not hold a seat*,
but the short version: with 4 seats a class, one abandoned checkout is 25% of the class, and that
design makes a background job load-bearing for revenue. If the reaper stops, capacity quietly
disappears. My version can leak a seat only if a process dies mid-charge, and if the reaper never
ran at all, nothing would be oversold.

That flipped the whole flow. It is why the seat is won at payment rather than at checkout, and why
the loser is never charged — which in turn deleted the refund path the first design needed.

**Two smaller corrections:**

- It reached for `SERIALIZABLE` plus a retry loop for the seat acquisition. That works, but it is
  heavier than the problem: a single `UPDATE ... WHERE seats_taken < capacity` is atomic under
  `READ COMMITTED` because Postgres re-evaluates the `WHERE` against the updated row after the
  lock frees. I went with the one-statement version and wrote down *why* it is sufficient, rather
  than reaching for the stronger isolation level as insurance against not knowing.
- Its first `payBooking` held the transaction open across the call to the payment provider. That
  makes the slowest card in the queue the upper bound on how fast a class can fill, so I split it
  into two transactions with the network call in between — which is what creates the stranded-hold
  case, and therefore the reaper.

## What I would change about my AI workflow

I let it write the schema and the booking logic in the same pass, and then spent time
reconciling the two — the `seat_held_at` / status `CHECK` constraint was retrofitted after I
noticed the two could disagree. Next time I would freeze the schema **and its constraints** first,
review only that, and treat it as the specification the code has to satisfy. The constraints are
the design; the TypeScript is an implementation of it.

I would also ask for the failure modes before the happy path. "What states can this get stuck in
if the process dies?" surfaced the stranded seat hold — but I asked it late, after the tests were
already written, so the reaper and its tests were bolted on rather than designed in.

## How I verified the final implementation

Not by reading the diff and nodding. In order of how much I trust them:

1. **`npm run demo:race`** — runs the brief's scenario plus three harder variants against the real
   database and asserts on each, exiting non-zero on any failure.
2. **44 tests** against a separate database, including a 25-way simultaneous stampede on a 4-seat
   class. Concurrency bugs do not reliably show up at 2 requests; they show up at 25.
3. **Every test ends with `expectInvariantsHold()`**, which re-queries the whole database and
   checks six system-wide properties — not just what the test's own return values said. This is
   what catches seat-counter drift, which a per-test assertion would miss entirely.
4. **Two tests bypass the application** and write to the tables directly, asserting the `CHECK`
   constraint and the unique index reject overbooking and duplicates. If those pass, the
   invariants hold no matter what any future code path does.
5. **By hand in two browser tabs**, following the steps in the README, to confirm the loser sees a
   sensible message and an empty payment-attempts table.
6. `npm run typecheck` and `npm run build` clean.

The check I trust most is #3, because it is the one that would fail if the code were subtly wrong
in a way I had not thought to test for.
