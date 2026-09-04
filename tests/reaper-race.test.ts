import { beforeEach, describe, expect, it } from 'vitest'
import { createBooking } from '../src/lib/booking/create-booking'
import { expireStaleHolds } from '../src/lib/booking/expire-holds'
import { payBooking } from '../src/lib/booking/pay-booking'
import { queryOne } from '../src/lib/db'
import {
  ageSeatHold,
  classState,
  countPaymentAttempts,
  expectInvariantsHold,
  resetToSeed,
  SEED,
} from './helpers'

const CLASS = SEED.classes.openScience

async function statusOf(bookingId: string): Promise<string> {
  const row = await queryOne<{ status: string }>(
    'SELECT status::text FROM bookings WHERE id = $1',
    [bookingId],
  )
  return row!.status
}

/**
 * The reaper and a charge that is still in flight both act on the same booking.
 *
 * `payBooking` deliberately releases its database connection while it talks to
 * the payment provider, so between TX1 (seat reserved) and TX2 (settle) another
 * process can legitimately touch the row. The reaper is exactly that process.
 *
 * These tests drive the two of them into each other on purpose. They are the
 * narrowest window in the system - the hold timeout is minutes and a charge is
 * seconds - but "narrow" is not "impossible", and a seat counter that drifts is
 * silent until a class is over- or under-sold.
 */
describe('the reaper firing while a charge is in flight', () => {
  beforeEach(resetToSeed)

  it('does not release the same seat twice when the charge then fails', async () => {
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })

    // Two other children legitimately hold seats, so a double release shows up
    // as a counter that disagrees with them.
    for (const studentId of [SEED.students.omar, SEED.students.ethan]) {
      const other = await createBooking({ studentId, trialClassId: CLASS })
      await payBooking(other.id, 'success')
    }
    expect((await classState(CLASS)).seats_taken).toBe(2)

    const inFlight = payBooking(booking.id, 'slow_failure')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await classState(CLASS)).seats_taken).toBe(3)

    // The provider is slow enough that the hold ages out underneath it.
    await ageSeatHold(booking.id, 3600)
    const report = await expireStaleHolds()
    expect(report.staleSeatHoldsReleased).toBe(1)
    expect((await classState(CLASS)).seats_taken).toBe(2)

    // Now the decline lands. It must NOT release a seat that is no longer its own.
    await inFlight

    const state = await classState(CLASS)
    expect(state.seats_taken).toBe(2)
    expect(state.confirmed_count).toBe(2)

    await expectInvariantsHold()
  })

  it('does not resurrect a reclaimed booking when the charge then succeeds', async () => {
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })

    const inFlight = payBooking(booking.id, 'slow_success')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await classState(CLASS)).seats_taken).toBe(1)

    await ageSeatHold(booking.id, 3600)
    await expireStaleHolds()
    expect(await statusOf(booking.id)).toBe('expired')
    expect((await classState(CLASS)).seats_taken).toBe(0)

    // The charge succeeded, but the seat is gone. The booking must not flip to
    // confirmed while holding no seat, and the successful charge must still be
    // recorded so it can be refunded.
    const result = await inFlight
    expect(result.outcome).toBe('seat_expired')
    expect(await statusOf(booking.id)).toBe('expired')
    expect(await countPaymentAttempts(booking.id)).toBe(1)

    const state = await classState(CLASS)
    expect(state.seats_taken).toBe(0)
    expect(state.confirmed_count).toBe(0)

    await expectInvariantsHold()
  })

  it('leaves the ordinary path untouched', async () => {
    // The guard must not break the case where nothing interferes.
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    expect((await payBooking(booking.id, 'slow_success')).outcome).toBe('confirmed')
    expect((await classState(CLASS)).confirmed_count).toBe(1)

    const declined = await createBooking({ studentId: SEED.students.omar, trialClassId: CLASS })
    expect((await payBooking(declined.id, 'slow_failure')).outcome).toBe('payment_failed')
    expect((await classState(CLASS)).seats_taken).toBe(1)

    await expectInvariantsHold()
  })
})
