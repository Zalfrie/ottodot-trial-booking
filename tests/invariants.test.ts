import { beforeEach, describe, expect, it } from 'vitest'
import { createBooking } from '../src/lib/booking/create-booking'
import { payBooking } from '../src/lib/booking/pay-booking'
import { getClassRoster } from '../src/lib/booking/queries'
import { query } from '../src/lib/db'
import { BookingError } from '../src/lib/errors'
import { classState, expectInvariantsHold, resetToSeed, SEED } from './helpers'

describe('duplicate bookings', () => {
  beforeEach(resetToSeed)

  it('refuses a second booking when the child is already confirmed', async () => {
    // Zara is confirmed on "Speed & Ratio" in the seed data.
    await expect(
      createBooking({
        studentId: SEED.students.zara,
        trialClassId: SEED.classes.duplicateMath,
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_BOOKING' })

    await expectInvariantsHold()
  })

  it('refuses a second booking while the first is still pending payment', async () => {
    const first = await createBooking({
      studentId: SEED.students.zara,
      trialClassId: SEED.classes.openScience,
    })
    expect(first.status).toBe('pending_payment')

    await expect(
      createBooking({
        studentId: SEED.students.zara,
        trialClassId: SEED.classes.openScience,
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_BOOKING' })

    await expectInvariantsHold()
  })

  it('refuses a second booking while a payment is in flight', async () => {
    const first = await createBooking({
      studentId: SEED.students.zara,
      trialClassId: SEED.classes.openScience,
    })
    const inFlight = payBooking(first.id, 'slow_success')
    await new Promise((resolve) => setTimeout(resolve, 200))

    await expect(
      createBooking({
        studentId: SEED.students.zara,
        trialClassId: SEED.classes.openScience,
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_BOOKING' })

    await inFlight
    await expectInvariantsHold()
  })

  it('lets exactly one of many simultaneous identical requests through', async () => {
    // The same parent double-clicking "Book", or a retried request.
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        createBooking({
          studentId: SEED.students.zara,
          trialClassId: SEED.classes.openScience,
        }),
      ),
    )

    const created = attempts.filter((a) => a.status === 'fulfilled')
    expect(created).toHaveLength(1)

    for (const rejection of attempts.filter((a) => a.status === 'rejected')) {
      expect((rejection as PromiseRejectedResult).reason).toBeInstanceOf(BookingError)
      expect((rejection as PromiseRejectedResult).reason.code).toBe('DUPLICATE_BOOKING')
    }

    await expectInvariantsHold()
  })

  it('allows a rebooking after a payment failure', async () => {
    // Omar's card was declined on "Speed & Ratio" in the seed data, so that
    // booking sits outside the partial unique index.
    const rebooked = await createBooking({
      studentId: SEED.students.omar,
      trialClassId: SEED.classes.duplicateMath,
    })
    expect(rebooked.status).toBe('pending_payment')

    await expectInvariantsHold()
  })

  it('allows a rebooking after a cancellation', async () => {
    const { cancelBooking } = await import('../src/lib/booking/cancel-booking')

    const first = await createBooking({
      studentId: SEED.students.zara,
      trialClassId: SEED.classes.openScience,
    })
    await cancelBooking(first.id)

    const second = await createBooking({
      studentId: SEED.students.zara,
      trialClassId: SEED.classes.openScience,
    })
    expect(second.id).not.toBe(first.id)

    await expectInvariantsHold()
  })
})

describe('capacity', () => {
  beforeEach(resetToSeed)

  it('refuses a booking for a class that is already full', async () => {
    // "The Human Body" has 4 of 4 confirmed. Kiran is not on it.
    await expect(
      createBooking({
        studentId: SEED.students.kiran,
        trialClassId: SEED.classes.fullScience,
      }),
    ).rejects.toMatchObject({ code: 'CLASS_FULL' })
  })

  it('never lets the roster exceed 4 students', async () => {
    const roster = await getClassRoster(SEED.classes.fullScience)
    expect(roster.students).toHaveLength(4)
    expect(roster.seats_available).toBe(0)
  })
})

describe('database-level constraints', () => {
  beforeEach(resetToSeed)

  // These bypass the application entirely. They are what makes the invariants
  // true regardless of what any current or future code path does.

  it('the CHECK constraint rejects overbooking written directly to the table', async () => {
    await expect(
      query('UPDATE trial_classes SET seats_taken = capacity + 1 WHERE id = $1', [
        SEED.classes.openScience,
      ]),
    ).rejects.toMatchObject({ code: '23514' }) // check_violation

    expect((await classState(SEED.classes.openScience)).seats_taken).toBe(0)
  })

  it('the CHECK constraint rejects a negative seat count', async () => {
    await expect(
      query('UPDATE trial_classes SET seats_taken = -1 WHERE id = $1', [
        SEED.classes.openScience,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('the unique index rejects a duplicate active booking written directly', async () => {
    await expect(
      query(
        `INSERT INTO bookings (student_id, trial_class_id, status, seat_held_at)
         VALUES ($1, $2, 'confirmed', now())`,
        [SEED.students.zara, SEED.classes.duplicateMath],
      ),
    ).rejects.toMatchObject({ code: '23505' }) // unique_violation
  })

  it('the CHECK constraint rejects a seat hold that disagrees with the status', async () => {
    await expect(
      query(
        `INSERT INTO bookings (student_id, trial_class_id, status, seat_held_at)
         VALUES ($1, $2, 'confirmed', NULL)`,
        [SEED.students.kiran, SEED.classes.openScience],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('input validation', () => {
  beforeEach(resetToSeed)

  it('rejects a malformed student id', async () => {
    await expect(
      createBooking({ studentId: 'not-a-uuid', trialClassId: SEED.classes.openScience }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('reports an unknown student', async () => {
    await expect(
      createBooking({
        studentId: '22222222-2222-2222-2222-222222229999',
        trialClassId: SEED.classes.openScience,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reports an unknown class', async () => {
    await expect(
      createBooking({
        studentId: SEED.students.zara,
        trialClassId: '33333333-3333-3333-3333-333333339999',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reports an unknown booking on payment', async () => {
    await expect(
      payBooking('44444444-4444-4444-4444-444444449999'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
