import { beforeEach, describe, expect, it } from 'vitest'
import { createBooking } from '../src/lib/booking/create-booking'
import { payBooking } from '../src/lib/booking/pay-booking'
import { getBookingDetail, getClassRoster } from '../src/lib/booking/queries'
import { BookingError } from '../src/lib/errors'
import {
  classState,
  countPaymentAttempts,
  expectInvariantsHold,
  resetToSeed,
  SEED,
} from './helpers'

const CLASS = SEED.classes.openScience

describe('payment failure', () => {
  beforeEach(resetToSeed)

  it('does not put the child on the roster', async () => {
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    const result = await payBooking(booking.id, 'failure')

    expect(result.outcome).toBe('payment_failed')
    expect(result.booking.status).toBe('payment_failed')

    const roster = await getClassRoster(CLASS)
    expect(roster.students).toHaveLength(0)

    await expectInvariantsHold()
  })

  it('releases the seat it briefly held', async () => {
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    await payBooking(booking.id, 'failure')

    const state = await classState(CLASS)
    expect(state.seats_taken).toBe(0)
    expect(state.seats_available).toBe(4)

    await expectInvariantsHold()
  })

  it('records the attempt with a failure reason', async () => {
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    const result = await payBooking(booking.id, 'failure')

    expect(result.outcome).toBe('payment_failed')
    if (result.outcome !== 'payment_failed') return
    expect(result.payment.status).toBe('failed')
    expect(result.payment.failure_reason).toBe('card_declined')

    const detail = await getBookingDetail(booking.id)
    expect(detail.payment_attempts).toHaveLength(1)
  })

  it('frees the seat for someone else', async () => {
    // Fill three seats, then have the fourth parent's card decline.
    const winners = [SEED.students.zara, SEED.students.omar, SEED.students.ethan]
    for (const studentId of winners) {
      const b = await createBooking({ studentId, trialClassId: CLASS })
      await payBooking(b.id, 'success')
    }

    const declined = await createBooking({ studentId: SEED.students.mei, trialClassId: CLASS })
    await payBooking(declined.id, 'failure')
    expect((await classState(CLASS)).seats_available).toBe(1)

    // The last seat is genuinely available again.
    const other = await createBooking({ studentId: SEED.students.kiran, trialClassId: CLASS })
    expect((await payBooking(other.id, 'success')).outcome).toBe('confirmed')

    const state = await classState(CLASS)
    expect(state.confirmed_count).toBe(4)
    expect(state.seats_available).toBe(0)

    await expectInvariantsHold()
  })

  it('allows a retry on the same booking', async () => {
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    await payBooking(booking.id, 'failure')

    const retry = await payBooking(booking.id, 'success')
    expect(retry.outcome).toBe('confirmed')
    expect(await countPaymentAttempts(booking.id)).toBe(2)

    const roster = await getClassRoster(CLASS)
    expect(roster.students.map((s) => s.student_id)).toEqual([SEED.students.zara])

    await expectInvariantsHold()
  })

  it('refuses the retry if the class filled up in the meantime', async () => {
    const declined = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    await payBooking(declined.id, 'failure')

    for (const studentId of [
      SEED.students.omar,
      SEED.students.ethan,
      SEED.students.mei,
      SEED.students.kiran,
    ]) {
      const b = await createBooking({ studentId, trialClassId: CLASS })
      await payBooking(b.id, 'success')
    }

    const retry = await payBooking(declined.id, 'success')
    expect(retry.outcome).toBe('class_full')
    // Still only the one failed attempt: the retry never reached the provider.
    expect(await countPaymentAttempts(declined.id)).toBe(1)

    await expectInvariantsHold()
  })
})

describe('payment state machine', () => {
  beforeEach(resetToSeed)

  it('refuses to pay an already-confirmed booking', async () => {
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    await payBooking(booking.id, 'success')

    await expect(payBooking(booking.id, 'success')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    expect(await countPaymentAttempts(booking.id)).toBe(1)
    expect((await classState(CLASS)).seats_taken).toBe(1)

    await expectInvariantsHold()
  })

  it('charges only once when the parent double-clicks Pay', async () => {
    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })

    const results = await Promise.allSettled([
      payBooking(booking.id, 'slow_success'),
      payBooking(booking.id, 'slow_success'),
      payBooking(booking.id, 'slow_success'),
    ])

    const settled = results.filter((r) => r.status === 'fulfilled')
    const refused = results.filter((r) => r.status === 'rejected')

    expect(settled).toHaveLength(1)
    expect(refused).toHaveLength(2)
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BookingError)
      expect((r as PromiseRejectedResult).reason.code).toBe('INVALID_STATE')
    }

    // One seat, one charge - not three.
    expect(await countPaymentAttempts(booking.id)).toBe(1)
    expect((await classState(CLASS)).seats_taken).toBe(1)

    await expectInvariantsHold()
  })

  it('refuses to pay a cancelled booking', async () => {
    const { cancelBooking } = await import('../src/lib/booking/cancel-booking')

    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    await cancelBooking(booking.id)

    await expect(payBooking(booking.id, 'success')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    expect(await countPaymentAttempts(booking.id)).toBe(0)
  })

  it('rejects an unknown simulate value at the edge', async () => {
    const { parsePaymentSimulation } = await import('../src/lib/booking/pay-booking')
    expect(() => parsePaymentSimulation({ simulate: 'refund_everything' })).toThrow(BookingError)
    expect(parsePaymentSimulation({})).toBe('success')
    expect(parsePaymentSimulation(null)).toBe('success')
  })
})

describe('cancellation', () => {
  beforeEach(resetToSeed)

  it('returns a confirmed booking’s seat to the class', async () => {
    const { cancelBooking } = await import('../src/lib/booking/cancel-booking')

    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    await payBooking(booking.id, 'success')
    expect((await classState(CLASS)).seats_taken).toBe(1)

    await cancelBooking(booking.id)

    const state = await classState(CLASS)
    expect(state.seats_taken).toBe(0)
    expect(state.confirmed_count).toBe(0)
    expect((await getClassRoster(CLASS)).students).toHaveLength(0)

    await expectInvariantsHold()
  })

  it('will not cancel underneath an in-flight payment', async () => {
    const { cancelBooking } = await import('../src/lib/booking/cancel-booking')

    const booking = await createBooking({ studentId: SEED.students.zara, trialClassId: CLASS })
    const inFlight = payBooking(booking.id, 'slow_success')
    await new Promise((resolve) => setTimeout(resolve, 200))

    await expect(cancelBooking(booking.id)).rejects.toMatchObject({ code: 'INVALID_STATE' })

    expect((await inFlight).outcome).toBe('confirmed')
    await expectInvariantsHold()
  })
})
