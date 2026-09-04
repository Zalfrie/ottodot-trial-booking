import type { PoolClient } from 'pg'

/**
 * Seat accounting. Both functions must be called inside a transaction that also
 * writes the matching booking row, so the counter and the bookings can never
 * disagree across a commit boundary.
 */

interface SeatRow {
  capacity: number
  seats_taken: number
}

/**
 * Atomically takes one seat, or reports that the class is full.
 *
 * This single statement IS the concurrency control for the last-seat race:
 *
 *   - `UPDATE` takes a ROW EXCLUSIVE lock on exactly this class row, so two
 *     checkouts for the same class are serialised while two checkouts for
 *     different classes never touch each other.
 *
 *   - Under READ COMMITTED (Postgres' default) a blocked UPDATE does not simply
 *     proceed once the lock frees: it re-reads the now-committed row and
 *     re-evaluates `seats_taken < capacity` against it (EvalPlanQual). So the
 *     loser of the race sees `seats_taken = capacity` and matches zero rows.
 *     There is no lost update and no need for SERIALIZABLE or an advisory lock.
 *
 *   - `trial_classes_seats_within_capacity` backstops all of the above at the
 *     database level. If this reasoning were ever wrong, or a future code path
 *     bypassed this function, the commit aborts instead of overbooking a class.
 *
 * Returns null when there was no seat to take.
 */
export async function tryAcquireSeat(
  client: PoolClient,
  trialClassId: string,
): Promise<SeatRow | null> {
  const { rows } = await client.query<SeatRow>(
    `UPDATE trial_classes
        SET seats_taken = seats_taken + 1
      WHERE id = $1
        AND seats_taken < capacity
      RETURNING capacity, seats_taken`,
    [trialClassId],
  )
  return rows[0] ?? null
}

/**
 * Returns a seat previously taken by `tryAcquireSeat`.
 *
 * The `seats_taken > 0` guard makes a double release a no-op rather than
 * driving the counter negative into a CHECK violation - releasing is called
 * from error paths, which are exactly the paths most likely to be retried.
 */
export async function releaseSeat(client: PoolClient, trialClassId: string): Promise<void> {
  await client.query(
    `UPDATE trial_classes
        SET seats_taken = seats_taken - 1
      WHERE id = $1
        AND seats_taken > 0`,
    [trialClassId],
  )
}
