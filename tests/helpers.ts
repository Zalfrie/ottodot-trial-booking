import { expect } from 'vitest'
import { getPool, query, queryOne } from '../src/lib/db'
import { findInvariantViolations } from '../src/lib/booking/invariants'
import { reseed, SEED } from '../scripts/reset-lib'

export { SEED }

/** Restores the seed data. Called from beforeEach in every test file. */
export async function resetToSeed(): Promise<void> {
  await reseed(getPool())
}

export interface ClassState {
  capacity: number
  seats_taken: number
  seats_available: number
  confirmed_count: number
  in_flight_count: number
}

export async function classState(trialClassId: string): Promise<ClassState> {
  const row = await queryOne<{
    capacity: number
    seats_taken: number
    seats_available: number
    confirmed_count: string
    in_flight_count: string
  }>(
    `SELECT capacity, seats_taken, seats_available, confirmed_count, in_flight_count
       FROM trial_class_availability WHERE id = $1`,
    [trialClassId],
  )
  if (!row) throw new Error(`No trial class ${trialClassId}`)
  return {
    capacity: row.capacity,
    seats_taken: row.seats_taken,
    seats_available: row.seats_available,
    confirmed_count: Number(row.confirmed_count),
    in_flight_count: Number(row.in_flight_count),
  }
}

export async function countPaymentAttempts(bookingId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    'SELECT count(*) AS n FROM payment_attempts WHERE booking_id = $1',
    [bookingId],
  )
  return Number(row!.n)
}

/**
 * Asserts every system-wide invariant. Called at the end of each scenario -
 * a test that only checks its own return values would miss counter drift.
 */
export async function expectInvariantsHold(): Promise<void> {
  const violations = await findInvariantViolations()
  expect(violations, `Invariant violations:\n${violations.map((v) => `  [${v.check}] ${v.detail}`).join('\n')}`).toEqual([])
}

/** Creates N extra students so a stampede can be wider than the seed data. */
export async function createStudents(count: number, namePrefix = 'Stress'): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `INSERT INTO students (parent_id, name, grade_level)
     SELECT $1, $2 || ' Child ' || g, 4
       FROM generate_series(1, $3) AS g
     RETURNING id`,
    [SEED.parents.aisha, namePrefix, count],
  )
  return rows.map((r) => r.id)
}

/** Forces a booking's seat hold to look older than it is, for reaper tests. */
export async function ageSeatHold(bookingId: string, seconds: number): Promise<void> {
  await query(
    `UPDATE bookings SET seat_held_at = now() - make_interval(secs => $2::numeric) WHERE id = $1`,
    [bookingId, seconds],
  )
}

/** Forces a booking's creation time backwards, for abandoned-checkout tests. */
export async function ageBooking(bookingId: string, seconds: number): Promise<void> {
  await query(
    `UPDATE bookings SET created_at = now() - make_interval(secs => $2::numeric) WHERE id = $1`,
    [bookingId, seconds],
  )
}
