import { beforeEach, describe, expect, it } from 'vitest'
import { createBooking } from '../src/lib/booking/create-booking'
import { payBooking } from '../src/lib/booking/pay-booking'
import { getClassRoster } from '../src/lib/booking/queries'
import {
  classState,
  countPaymentAttempts,
  createStudents,
  expectInvariantsHold,
  resetToSeed,
  SEED,
} from './helpers'

const LAST_SEAT_CLASS = SEED.classes.lastSeatMath // 3 confirmed of 4
const OPEN_CLASS = SEED.classes.openScience // 0 of 4

describe('the last-seat race', () => {
  beforeEach(resetToSeed)

  it('is set up as expected: exactly one seat left', async () => {
    const state = await classState(LAST_SEAT_CLASS)
    expect(state.seats_taken).toBe(3)
    expect(state.capacity).toBe(4)
    expect(state.seats_available).toBe(1)
  })

  it('resolves the scenario from the brief: B pays first, A is refused', async () => {
    // 1. User A selects the last available slot and moves to payment.
    const a = await createBooking({
      studentId: SEED.students.zara,
      trialClassId: LAST_SEAT_CLASS,
    })
    expect(a.status).toBe('pending_payment')

    // 2. User B selects the same slot.
    const b = await createBooking({
      studentId: SEED.students.omar,
      trialClassId: LAST_SEAT_CLASS,
    })
    expect(b.status).toBe('pending_payment')

    // Neither pending booking has taken the seat.
    expect((await classState(LAST_SEAT_CLASS)).seats_taken).toBe(3)

    // 3. User B completes payment first and confirms the booking.
    const resultB = await payBooking(b.id, 'success')
    expect(resultB.outcome).toBe('confirmed')
    expect((await classState(LAST_SEAT_CLASS)).seats_taken).toBe(4)

    // 4. User A then tries to complete payment.
    const resultA = await payBooking(a.id, 'success')
    expect(resultA.outcome).toBe('class_full')
    expect(resultA.booking.status).toBe('cancelled')
    expect(resultA.booking.cancellation_reason).toBe('class_full')

    // The crucial part: A was never charged, so there is nothing to refund.
    expect(await countPaymentAttempts(a.id)).toBe(0)

    const state = await classState(LAST_SEAT_CLASS)
    expect(state.seats_taken).toBe(4)
    expect(state.confirmed_count).toBe(4)

    const roster = await getClassRoster(LAST_SEAT_CLASS)
    expect(roster.students).toHaveLength(4)
    expect(roster.students.map((s) => s.student_id)).toContain(SEED.students.omar)
    expect(roster.students.map((s) => s.student_id)).not.toContain(SEED.students.zara)

    await expectInvariantsHold()
  })

  it('resolves it the same way when A pays first', async () => {
    const a = await createBooking({ studentId: SEED.students.zara, trialClassId: LAST_SEAT_CLASS })
    const b = await createBooking({ studentId: SEED.students.omar, trialClassId: LAST_SEAT_CLASS })

    expect((await payBooking(a.id, 'success')).outcome).toBe('confirmed')
    expect((await payBooking(b.id, 'success')).outcome).toBe('class_full')
    expect(await countPaymentAttempts(b.id)).toBe(0)

    await expectInvariantsHold()
  })

  it('lets exactly one of two simultaneous payments win the last seat', async () => {
    const a = await createBooking({ studentId: SEED.students.zara, trialClassId: LAST_SEAT_CLASS })
    const b = await createBooking({ studentId: SEED.students.omar, trialClassId: LAST_SEAT_CLASS })

    const results = await Promise.all([
      payBooking(a.id, 'success'),
      payBooking(b.id, 'success'),
    ])

    const outcomes = results.map((r) => r.outcome).sort()
    expect(outcomes).toEqual(['class_full', 'confirmed'])

    const state = await classState(LAST_SEAT_CLASS)
    expect(state.seats_taken).toBe(4)
    expect(state.confirmed_count).toBe(4)

    await expectInvariantsHold()
  })

  it('still refuses the loser when the winner pays slowly', async () => {
    // `slow_success` reserves the seat immediately but settles 1.5s later, so
    // the loser hits the class while the winner is mid-charge - the widest
    // version of the race window.
    const a = await createBooking({ studentId: SEED.students.zara, trialClassId: LAST_SEAT_CLASS })
    const b = await createBooking({ studentId: SEED.students.omar, trialClassId: LAST_SEAT_CLASS })

    const slow = payBooking(a.id, 'slow_success')
    await new Promise((resolve) => setTimeout(resolve, 200))

    // While A is still at the provider, the seat is already A's.
    const midFlight = await classState(LAST_SEAT_CLASS)
    expect(midFlight.seats_taken).toBe(4)
    expect(midFlight.in_flight_count).toBe(1)
    expect(midFlight.confirmed_count).toBe(3) // not on the roster until it settles

    const fast = await payBooking(b.id, 'success')
    expect(fast.outcome).toBe('class_full')
    expect(await countPaymentAttempts(b.id)).toBe(0)

    expect((await slow).outcome).toBe('confirmed')

    const roster = await getClassRoster(LAST_SEAT_CLASS)
    expect(roster.students.map((s) => s.student_id)).toContain(SEED.students.zara)
    expect(roster.students).toHaveLength(4)

    await expectInvariantsHold()
  })

  it('gives out exactly 4 seats when 25 parents stampede an empty class', async () => {
    const studentIds = await createStudents(25)

    const bookings = await Promise.all(
      studentIds.map((studentId) => createBooking({ studentId, trialClassId: OPEN_CLASS })),
    )
    const results = await Promise.all(bookings.map((b) => payBooking(b.id, 'success')))

    const confirmed = results.filter((r) => r.outcome === 'confirmed')
    const refused = results.filter((r) => r.outcome === 'class_full')

    expect(confirmed).toHaveLength(4)
    expect(refused).toHaveLength(21)

    const state = await classState(OPEN_CLASS)
    expect(state.seats_taken).toBe(4)
    expect(state.confirmed_count).toBe(4)
    expect(state.seats_available).toBe(0)

    // None of the 21 losers was charged.
    const loserBookingIds = results
      .filter((r) => r.outcome === 'class_full')
      .map((r) => r.booking.id)
    const charges = await Promise.all(loserBookingIds.map(countPaymentAttempts))
    expect(charges.every((n) => n === 0)).toBe(true)

    await expectInvariantsHold()
  })

  it('keeps races on different classes independent', async () => {
    const studentIds = await createStudents(16)
    const half = studentIds.length / 2

    const bookings = await Promise.all([
      ...studentIds
        .slice(0, half)
        .map((studentId) => createBooking({ studentId, trialClassId: OPEN_CLASS })),
      ...studentIds
        .slice(half)
        .map((studentId) => createBooking({ studentId, trialClassId: LAST_SEAT_CLASS })),
    ])

    await Promise.all(bookings.map((b) => payBooking(b.id, 'success')))

    expect((await classState(OPEN_CLASS)).confirmed_count).toBe(4)
    expect((await classState(LAST_SEAT_CLASS)).confirmed_count).toBe(4)

    await expectInvariantsHold()
  })
})
