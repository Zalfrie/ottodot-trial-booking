import type { PoolClient } from 'pg'
import { withTransaction } from '@/lib/db'
import { BookingError, isPgError, PG_UNIQUE_VIOLATION } from '@/lib/errors'
import { charge, isPaymentSimulation, type PaymentSimulation } from '@/lib/payments/gateway'
import { releaseSeat, tryAcquireSeat } from './seats'
import type { Booking, PaymentAttempt } from './types'

export type PayBookingResult =
  | { outcome: 'confirmed'; booking: Booking; payment: PaymentAttempt }
  | { outcome: 'payment_failed'; booking: Booking; payment: PaymentAttempt }
  | { outcome: 'class_full'; booking: Booking }

export function parsePaymentSimulation(body: unknown): PaymentSimulation {
  if (body === null || body === undefined) return 'success'
  if (typeof body !== 'object') {
    throw new BookingError('VALIDATION_ERROR', 'Request body must be a JSON object')
  }
  const raw = (body as Record<string, unknown>).simulate
  if (raw === undefined) return 'success'
  if (!isPaymentSimulation(raw)) {
    throw new BookingError(
      'VALIDATION_ERROR',
      "simulate must be one of 'success', 'failure', 'slow_success'",
    )
  }
  return raw
}

/**
 * Takes a booking from `pending_payment` (or a retry from `payment_failed`) to a
 * final state.
 *
 * The ordering is the whole point: **reserve the seat, then charge the card.**
 * A parent is never charged for a seat that turned out not to exist, which
 * removes the need for a refund path on the last-seat race entirely.
 *
 *   TX1  lock the booking row -> take a seat atomically -> `processing_payment`
 *        (or, if there is no seat left, `cancelled` / class_full and STOP - the
 *        card is never touched)
 *   ---  call the payment provider, holding no locks
 *   TX2  `confirmed`, or release the seat and go to `payment_failed`
 *
 * The gap between TX1 and TX2 is the only place a seat can leak, and only if the
 * process dies mid-charge. `scripts/expire-stale-holds.ts` reclaims those.
 */
export async function payBooking(
  bookingId: string,
  simulate: PaymentSimulation = 'success',
): Promise<PayBookingResult> {
  const reserved = await reserveSeatForPayment(bookingId)

  if (reserved.kind === 'class_full') {
    return { outcome: 'class_full', booking: reserved.booking }
  }

  const result = await charge({
    amountCents: reserved.amountCents,
    currency: reserved.currency,
    idempotencyKey: bookingId,
    simulate,
  })

  return settlePayment(reserved.booking, reserved.amountCents, reserved.currency, result)
}

// --- TX1 --------------------------------------------------------------------

type ReserveResult =
  | { kind: 'seat_acquired'; booking: Booking; amountCents: number; currency: string }
  | { kind: 'class_full'; booking: Booking }

async function reserveSeatForPayment(bookingId: string): Promise<ReserveResult> {
  return withTransaction(async (client) => {
    // `FOR UPDATE OF b` locks the booking, not the class. Two concurrent pay
    // calls for the SAME booking serialise here, so the second one finds the
    // booking already in `processing_payment` and is rejected instead of
    // charging the card twice.
    const { rows } = await client.query<
      Booking & { price_cents: number; class_starts_at: Date }
    >(
      `SELECT b.*, c.price_cents, c.starts_at AS class_starts_at
         FROM bookings b
         JOIN trial_classes c ON c.id = b.trial_class_id
        WHERE b.id = $1
        FOR UPDATE OF b`,
      [bookingId],
    )

    const booking = rows[0]
    if (!booking) {
      throw new BookingError('NOT_FOUND', 'Booking not found', { bookingId })
    }

    assertPayable(booking)

    if (booking.class_starts_at.getTime() <= Date.now()) {
      throw new BookingError('INVALID_STATE', 'This trial class has already started')
    }

    const seat = await tryAcquireSeat(client, booking.trial_class_id)

    if (!seat) {
      // Someone else took the last seat while this parent was at the payment
      // step. Close the booking out and return WITHOUT charging.
      const { rows: cancelled } = await client.query<Booking>(
        `UPDATE bookings
            SET status = 'cancelled',
                cancellation_reason = 'class_full',
                seat_held_at = NULL,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [bookingId],
      )
      return { kind: 'class_full', booking: cancelled[0]! }
    }

    try {
      const { rows: held } = await client.query<Booking>(
        `UPDATE bookings
            SET status = 'processing_payment',
                seat_held_at = now(),
                cancellation_reason = NULL,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [bookingId],
      )
      return {
        kind: 'seat_acquired',
        booking: held[0]!,
        amountCents: booking.price_cents,
        currency: 'SGD',
      }
    } catch (error) {
      // Retrying a `payment_failed` booking moves it back inside the partial
      // unique index. If the parent meanwhile created a fresh booking for the
      // same class, that index fires - and the ROLLBACK returns the seat.
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        throw new BookingError(
          'DUPLICATE_BOOKING',
          'This child already has another active booking for this class',
        )
      }
      throw error
    }
  })
}

function assertPayable(booking: Booking): void {
  switch (booking.status) {
    case 'pending_payment':
    case 'payment_failed': // an explicit retry on the same booking
      return
    case 'processing_payment':
      throw new BookingError('INVALID_STATE', 'A payment for this booking is already in progress')
    case 'confirmed':
      throw new BookingError('INVALID_STATE', 'This booking is already confirmed')
    case 'cancelled':
    case 'expired':
      throw new BookingError('INVALID_STATE', `This booking is ${booking.status} and cannot be paid`)
  }
}

// --- TX2 --------------------------------------------------------------------

async function settlePayment(
  booking: Booking,
  amountCents: number,
  currency: string,
  result: Awaited<ReturnType<typeof charge>>,
): Promise<PayBookingResult> {
  return withTransaction(async (client) => {
    if (result.status === 'succeeded') {
      const { rows } = await client.query<Booking>(
        `UPDATE bookings
            SET status = 'confirmed',
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [booking.id],
      )
      const payment = await recordAttempt(client, {
        bookingId: booking.id,
        amountCents,
        currency,
        status: 'succeeded',
        providerRef: result.providerRef,
      })
      return { outcome: 'confirmed', booking: rows[0]!, payment }
    }

    // Declined. Give the seat back in the same transaction that records the
    // failure, so a failed payment can never leave the child holding a seat.
    await releaseSeat(client, booking.trial_class_id)

    const { rows } = await client.query<Booking>(
      `UPDATE bookings
          SET status = 'payment_failed',
              seat_held_at = NULL,
              cancellation_reason = 'payment_failed',
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [booking.id],
    )
    const payment = await recordAttempt(client, {
      bookingId: booking.id,
      amountCents,
      currency,
      status: 'failed',
      providerRef: result.providerRef,
      failureReason: result.failureReason,
    })
    return { outcome: 'payment_failed', booking: rows[0]!, payment }
  })
}

async function recordAttempt(
  client: PoolClient,
  input: {
    bookingId: string
    amountCents: number
    currency: string
    status: 'succeeded' | 'failed'
    providerRef: string
    failureReason?: string
  },
): Promise<PaymentAttempt> {
  const { rows } = await client.query<PaymentAttempt>(
    `INSERT INTO payment_attempts
       (booking_id, amount_cents, currency, status, provider_ref, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.bookingId,
      input.amountCents,
      input.currency,
      input.status,
      input.providerRef,
      input.failureReason ?? null,
    ],
  )
  return rows[0]!
}
