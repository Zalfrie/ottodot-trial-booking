import { query } from '@/lib/db'

export interface InvariantViolation {
  check: string
  detail: string
}

/**
 * The properties that must hold after ANY sequence of operations.
 *
 * Two of these (capacity, uniqueness) are also database constraints, so they
 * should be unfalsifiable - which is exactly why they are worth asserting: if
 * one ever fires, a constraint was dropped or bypassed.
 *
 * The others cover the denormalised seat counter, which no constraint can check
 * because it spans rows.
 *
 * Used by the test suite after every concurrency scenario, and by
 * `npm run db:check` against a live database.
 */
export async function findInvariantViolations(): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = []

  // 1. The denormalised counter still agrees with the bookings it summarises.
  const drift = await query<{ title: string; seats_taken: number; actual_holders: number }>(
    `SELECT c.title,
            c.seats_taken,
            (SELECT count(*)::int FROM bookings b
              WHERE b.trial_class_id = c.id
                AND b.status IN ('processing_payment', 'confirmed')) AS actual_holders
       FROM trial_classes c`,
  )
  for (const row of drift) {
    if (row.seats_taken !== row.actual_holders) {
      violations.push({
        check: 'seat counter matches bookings',
        detail: `"${row.title}": seats_taken=${row.seats_taken} but ${row.actual_holders} bookings hold a seat`,
      })
    }
  }

  // 2. No class is over capacity.
  const over = await query<{ title: string; seats_taken: number; capacity: number }>(
    'SELECT title, seats_taken, capacity FROM trial_classes WHERE seats_taken > capacity',
  )
  for (const row of over) {
    violations.push({
      check: 'no class over capacity',
      detail: `"${row.title}": ${row.seats_taken}/${row.capacity}`,
    })
  }

  // 3. No roster is over capacity.
  const overConfirmed = await query<{ title: string; confirmed_count: string; capacity: number }>(
    `SELECT title, confirmed_count, capacity
       FROM trial_class_availability
      WHERE confirmed_count > capacity`,
  )
  for (const row of overConfirmed) {
    violations.push({
      check: 'no roster over capacity',
      detail: `"${row.title}": ${row.confirmed_count} confirmed for ${row.capacity} seats`,
    })
  }

  // 4. At most one active booking per (student, class).
  const dupes = await query<{ student_id: string; trial_class_id: string; n: string }>(
    `SELECT student_id, trial_class_id, count(*) AS n
       FROM bookings
      WHERE status IN ('pending_payment', 'processing_payment', 'confirmed')
      GROUP BY student_id, trial_class_id
     HAVING count(*) > 1`,
  )
  for (const row of dupes) {
    violations.push({
      check: 'one active booking per student+class',
      detail: `student ${row.student_id} has ${row.n} active bookings for class ${row.trial_class_id}`,
    })
  }

  // 5. seat_held_at agrees with status.
  const holdMismatch = await query<{ id: string; status: string }>(
    `SELECT id, status FROM bookings
      WHERE (status IN ('processing_payment', 'confirmed') AND seat_held_at IS NULL)
         OR (status NOT IN ('processing_payment', 'confirmed') AND seat_held_at IS NOT NULL)`,
  )
  for (const row of holdMismatch) {
    violations.push({
      check: 'seat_held_at agrees with status',
      detail: `booking ${row.id} is ${row.status} with a mismatched seat_held_at`,
    })
  }

  // 6. A confirmed booking has a succeeded payment; a payment_failed one does not.
  const paymentMismatch = await query<{ id: string; status: string }>(
    `SELECT b.id, b.status::text
       FROM bookings b
      WHERE (b.status = 'confirmed' AND NOT EXISTS (
               SELECT 1 FROM payment_attempts pa
                WHERE pa.booking_id = b.id AND pa.status = 'succeeded'))
         OR (b.status = 'payment_failed' AND EXISTS (
               SELECT 1 FROM payment_attempts pa
                WHERE pa.booking_id = b.id AND pa.status = 'succeeded'
                  AND pa.created_at > (SELECT max(created_at) FROM payment_attempts p2
                                        WHERE p2.booking_id = b.id AND p2.status = 'failed')))`,
  )
  for (const row of paymentMismatch) {
    violations.push({
      check: 'booking status agrees with payment attempts',
      detail: `booking ${row.id} is ${row.status} but its payment attempts say otherwise`,
    })
  }

  return violations
}

export const INVARIANT_NAMES = [
  'seat counter reconciles with bookings',
  'no class over capacity',
  'no roster over capacity',
  'no duplicate active bookings',
  'seat holds agree with booking status',
  'booking status agrees with payment attempts',
] as const
