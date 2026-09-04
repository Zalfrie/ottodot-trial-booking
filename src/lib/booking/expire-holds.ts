import { withTransaction } from '@/lib/db'
import { config } from '@/lib/config'

export interface ExpiryReport {
  /** Crashed checkouts whose seat was reclaimed. */
  staleSeatHoldsReleased: number
  /** Abandoned `pending_payment` bookings closed out. They held no seat. */
  abandonedBookingsExpired: number
}

/**
 * Background job: the only correctness-relevant one in the system.
 *
 * Both the success and the decline path release their own seat, so a seat can
 * only be stranded if the process dies between reserving it and settling the
 * charge. This job is what makes that failure self-healing rather than a slow
 * leak of capacity.
 *
 * The second half (expiring abandoned `pending_payment` rows) is pure hygiene -
 * those bookings hold nothing. It exists so an abandoned checkout does not block
 * the same child from booking the same class again via the unique index.
 *
 * Idempotent: running it twice changes nothing the second time.
 */
export async function expireStaleHolds(): Promise<ExpiryReport> {
  return withTransaction(async (client) => {
    // Reclaim seats from checkouts that never settled.
    //
    // The seat counter is decremented by joining the affected classes back to
    // the set of bookings just expired, so the counter and the booking rows move
    // together, in one transaction.
    const { rows: released } = await client.query<{ id: string; trial_class_id: string }>(
      `WITH stale AS (
         UPDATE bookings
            SET status = 'expired',
                seat_held_at = NULL,
                cancellation_reason = 'stale_seat_hold',
                updated_at = now()
          WHERE status = 'processing_payment'
            AND seat_held_at < now() - make_interval(secs => $1::numeric)
          RETURNING id, trial_class_id
       ),
       per_class AS (
         SELECT trial_class_id, count(*)::int AS n FROM stale GROUP BY trial_class_id
       ),
       bumped AS (
         UPDATE trial_classes c
            SET seats_taken = GREATEST(c.seats_taken - pc.n, 0)
           FROM per_class pc
          WHERE c.id = pc.trial_class_id
          RETURNING c.id
       )
       SELECT id, trial_class_id FROM stale`,
      [config.seatHoldTimeoutSeconds],
    )

    const { rows: abandoned } = await client.query<{ id: string }>(
      `UPDATE bookings
          SET status = 'expired',
              cancellation_reason = 'abandoned',
              updated_at = now()
        WHERE status = 'pending_payment'
          AND created_at < now() - make_interval(secs => $1::numeric)
        RETURNING id`,
      [config.pendingBookingTimeoutSeconds],
    )

    return {
      staleSeatHoldsReleased: released.length,
      abandonedBookingsExpired: abandoned.length,
    }
  })
}
