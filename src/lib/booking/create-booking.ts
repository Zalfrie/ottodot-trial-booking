import type { PoolClient } from 'pg'
import { queryOne, withTransaction } from '@/lib/db'
import { BookingError, isPgError, PG_UNIQUE_VIOLATION } from '@/lib/errors'
import type { Booking } from './types'

interface CreateBookingInput {
  studentId: string
  trialClassId: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new BookingError('VALIDATION_ERROR', `${field} must be a UUID`, { field })
  }
  return value
}

export function parseCreateBookingInput(body: unknown): CreateBookingInput {
  if (typeof body !== 'object' || body === null) {
    throw new BookingError('VALIDATION_ERROR', 'Request body must be a JSON object')
  }
  const raw = body as Record<string, unknown>
  return {
    studentId: assertUuid(raw.studentId, 'studentId'),
    trialClassId: assertUuid(raw.trialClassId, 'trialClassId'),
  }
}

/**
 * Creates a booking in `pending_payment`.
 *
 * Deliberately does NOT reserve a seat - see README, "Why pending_payment does
 * not hold a seat". The capacity check here is advisory: it stops an obviously
 * pointless checkout, but the seat is only actually won in `payBooking`.
 */
export async function createBooking(input: CreateBookingInput): Promise<Booking> {
  // Validated here, not only at the HTTP edge, so the domain function is safe to
  // call from a script or a job without re-deriving the rules.
  assertUuid(input.studentId, 'studentId')
  assertUuid(input.trialClassId, 'trialClassId')

  return withTransaction(async (client) => {
    const { rows: studentRows } = await client.query<{ id: string }>(
      'SELECT id FROM students WHERE id = $1',
      [input.studentId],
    )
    if (!studentRows[0]) {
      throw new BookingError('NOT_FOUND', 'Student not found', { studentId: input.studentId })
    }

    const { rows: classRows } = await client.query<{
      id: string
      capacity: number
      seats_taken: number
      starts_at: Date
    }>('SELECT id, capacity, seats_taken, starts_at FROM trial_classes WHERE id = $1', [
      input.trialClassId,
    ])
    const trialClass = classRows[0]
    if (!trialClass) {
      throw new BookingError('NOT_FOUND', 'Trial class not found', {
        trialClassId: input.trialClassId,
      })
    }

    if (trialClass.starts_at.getTime() <= Date.now()) {
      throw new BookingError('INVALID_STATE', 'This trial class has already started')
    }

    // Checked BEFORE capacity, so a parent whose child is already confirmed on a
    // full class is told "already booked" rather than the confusing "class is
    // full" - their child does have a seat. The unique index below is still what
    // makes this true under concurrency; this only picks the better message.
    const existingBooking = await findActiveBooking(
      input.studentId,
      input.trialClassId,
      client,
    )
    if (existingBooking) {
      throw new BookingError(
        'DUPLICATE_BOOKING',
        'This child already has an active booking for this class',
        { existingBookingId: existingBooking.id, existingStatus: existingBooking.status },
      )
    }

    // Advisory only. Two parents can both pass this check for the same last
    // seat - that is the race the brief asks about, and it is settled at payment
    // time, not here.
    if (trialClass.seats_taken >= trialClass.capacity) {
      throw new BookingError('CLASS_FULL', 'This trial class is full', {
        capacity: trialClass.capacity,
        seatsTaken: trialClass.seats_taken,
      })
    }

    try {
      const { rows } = await client.query<Booking>(
        `INSERT INTO bookings (student_id, trial_class_id, status)
         VALUES ($1, $2, 'pending_payment')
         RETURNING *`,
        [input.studentId, input.trialClassId],
      )
      // INSERT ... RETURNING always yields a row when it does not throw.
      return rows[0]!
    } catch (error) {
      // The partial unique index rejected it: this student already has a
      // pending, in-flight or confirmed booking for this class.
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        const existing = await findActiveBooking(input.studentId, input.trialClassId)
        throw new BookingError(
          'DUPLICATE_BOOKING',
          'This child already has an active booking for this class',
          { existingBookingId: existing?.id, existingStatus: existing?.status },
        )
      }
      throw error
    }
  })
}

/**
 * The booking, if any, that currently blocks this child from booking this class.
 *
 * Pass `client` to read inside an open transaction; without it the shared pool
 * is used. This is a *read* of a racy condition - the partial unique index is
 * what actually enforces it.
 */
export async function findActiveBooking(
  studentId: string,
  trialClassId: string,
  client?: PoolClient,
): Promise<Booking | undefined> {
  const sql = `SELECT * FROM bookings
                WHERE student_id = $1
                  AND trial_class_id = $2
                  AND status IN ('pending_payment', 'processing_payment', 'confirmed')`
  const params = [studentId, trialClassId]

  if (client) {
    const { rows } = await client.query<Booking>(sql, params)
    return rows[0]
  }
  return queryOne<Booking>(sql, params)
}
