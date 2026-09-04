import { withTransaction } from '@/lib/db'
import { BookingError } from '@/lib/errors'
import { releaseSeat } from './seats'
import { SEAT_HOLDING_STATUSES, type Booking } from './types'

/**
 * Cancels a booking and, if it was holding a seat, returns that seat to the
 * class in the same transaction.
 */
export async function cancelBooking(
  bookingId: string,
  reason = 'requested_by_parent',
): Promise<Booking> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<Booking>(
      'SELECT * FROM bookings WHERE id = $1 FOR UPDATE',
      [bookingId],
    )
    const booking = rows[0]
    if (!booking) {
      throw new BookingError('NOT_FOUND', 'Booking not found', { bookingId })
    }

    if (booking.status === 'cancelled') return booking

    if (booking.status === 'processing_payment') {
      throw new BookingError(
        'INVALID_STATE',
        'A payment is in progress for this booking; wait for it to settle',
      )
    }

    if (SEAT_HOLDING_STATUSES.includes(booking.status)) {
      await releaseSeat(client, booking.trial_class_id)
    }

    const { rows: updated } = await client.query<Booking>(
      `UPDATE bookings
          SET status = 'cancelled',
              seat_held_at = NULL,
              cancellation_reason = $2,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [bookingId, reason],
    )
    return updated[0]!
  })
}
