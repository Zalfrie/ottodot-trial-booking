import { beforeEach, describe, expect, it } from 'vitest'
import { createBooking } from '../src/lib/booking/create-booking'
import { expireStaleHolds } from '../src/lib/booking/expire-holds'
import { payBooking } from '../src/lib/booking/pay-booking'
import { config } from '../src/lib/config'
import { queryOne } from '../src/lib/db'
import {
  ageBooking,
  ageSeatHold,
  classState,
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
 * Simulates the one failure the happy and unhappy paths cannot clean up after
 * themselves: the process dies after the seat is reserved but before the charge
 * settles, leaving the booking stuck in `processing_payment`.
 */
async function strandSeatHold(studentId: string): Promise<string> {
  const booking = await createBooking({ studentId, trialClassId: CLASS })
  const inFlight = payBooking(booking.id, 'slow_success')
  await new Promise((resolve) => setTimeout(resolve, 150))
  // The seat is now held; let the charge settle in the background but age the
  // hold so the reaper treats it as abandoned.
  void inFlight.catch(() => {})
  return booking.id
}

describe('the stale seat-hold reaper', () => {
  beforeEach(resetToSeed)

  it('leaves a fresh in-flight payment alone', async () => {
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    const inFlight = payBooking(booking.id, 'slow_success')
    await new Promise((resolve) => setTimeout(resolve, 150))

    const report = await expireStaleHolds()
    expect(report.staleSeatHoldsReleased).toBe(0)
    expect(await statusOf(booking.id)).toBe('processing_payment')

    expect((await inFlight).outcome).toBe('confirmed')
    await expectInvariantsHold()
  })

  it('reclaims the seat from a checkout that died mid-charge', async () => {
    // Reproduce the stranded state directly: a booking that reserved a seat and
    // whose process never came back.
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    const inFlight = payBooking(booking.id, 'slow_success')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect((await classState(CLASS)).seats_taken).toBe(1)

    await inFlight // let it finish so nothing writes underneath the reaper
    // Put it back into the stranded state and age it past the timeout.
    const { query } = await import('../src/lib/db')
    await query(
      `UPDATE bookings SET status = 'processing_payment', updated_at = now() WHERE id = $1`,
      [booking.id],
    )
    await ageSeatHold(booking.id, config.seatHoldTimeoutSeconds + 60)

    const report = await expireStaleHolds()
    expect(report.staleSeatHoldsReleased).toBe(1)
    expect(await statusOf(booking.id)).toBe('expired')

    const state = await classState(CLASS)
    expect(state.seats_taken).toBe(0)
    expect(state.seats_available).toBe(4)

    await expectInvariantsHold()
  })

  it('expires an abandoned pending booking, which held no seat', async () => {
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    await ageBooking(booking.id, config.pendingBookingTimeoutSeconds + 60)

    expect((await classState(CLASS)).seats_taken).toBe(0)

    const report = await expireStaleHolds()
    expect(report.abandonedBookingsExpired).toBe(1)
    expect(await statusOf(booking.id)).toBe('expired')
    expect((await classState(CLASS)).seats_taken).toBe(0)

    await expectInvariantsHold()
  })

  it('frees the child to book that class again', async () => {
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    await ageBooking(booking.id, config.pendingBookingTimeoutSeconds + 60)
    await expireStaleHolds()

    const rebooked = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    expect(rebooked.id).not.toBe(booking.id)

    await expectInvariantsHold()
  })

  it('is idempotent', async () => {
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    await ageBooking(booking.id, config.pendingBookingTimeoutSeconds + 60)

    const first = await expireStaleHolds()
    const second = await expireStaleHolds()

    expect(first.abandonedBookingsExpired).toBe(1)
    expect(second.abandonedBookingsExpired).toBe(0)
    expect(second.staleSeatHoldsReleased).toBe(0)

    await expectInvariantsHold()
  })

  it('does nothing on a clean database', async () => {
    const report = await expireStaleHolds()
    expect(report).toEqual({ staleSeatHoldsReleased: 0, abandonedBookingsExpired: 0 })
    await expectInvariantsHold()
  })

  it('reclaims several stranded seats across classes in one pass', async () => {
    const { query } = await import('../src/lib/db')

    const ids: string[] = []
    for (const studentId of [SEED.students.zara, SEED.students.omar, SEED.students.ethan]) {
      const b = await createBooking({ studentId, trialClassId: CLASS })
      await payBooking(b.id, 'success')
      ids.push(b.id)
    }
    expect((await classState(CLASS)).seats_taken).toBe(3)

    // Strand all three.
    await query(
      `UPDATE bookings SET status = 'processing_payment', updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [ids],
    )
    for (const id of ids) await ageSeatHold(id, config.seatHoldTimeoutSeconds + 60)

    const report = await expireStaleHolds()
    expect(report.staleSeatHoldsReleased).toBe(3)
    expect((await classState(CLASS)).seats_taken).toBe(0)

    await expectInvariantsHold()
  })
})

// Keeps the unused-helper lint honest: `strandSeatHold` documents the failure
// mode above, and is exercised here.
describe('stranded hold helper', () => {
  beforeEach(resetToSeed)

  it('produces a booking that is holding a seat', async () => {
    const id = await strandSeatHold(SEED.students.kiran)
    expect(await statusOf(id)).toBe('processing_payment')
    expect((await classState(CLASS)).seats_taken).toBe(1)
    // Let the background charge settle before the suite tears down.
    await new Promise((resolve) => setTimeout(resolve, 1600))
  })
})
