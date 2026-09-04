import { query, queryOne } from '@/lib/db'
import { BookingError } from '@/lib/errors'
import type {
  Booking,
  ClassRoster,
  Parent,
  PaymentAttempt,
  Student,
  TrialClassAvailability,
} from './types'

export function listTrialClasses(): Promise<TrialClassAvailability[]> {
  return query<TrialClassAvailability>(
    'SELECT * FROM trial_class_availability ORDER BY starts_at ASC',
  )
}

export function getTrialClass(id: string): Promise<TrialClassAvailability | undefined> {
  return queryOne<TrialClassAvailability>('SELECT * FROM trial_class_availability WHERE id = $1', [
    id,
  ])
}

export function listParentsWithStudents(): Promise<(Parent & { students: Student[] })[]> {
  return query<Parent & { students: Student[] }>(
    `SELECT p.id,
            p.name,
            p.email,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', s.id,
                  'parent_id', s.parent_id,
                  'name', s.name,
                  'grade_level', s.grade_level
                ) ORDER BY s.name
              ) FILTER (WHERE s.id IS NOT NULL),
              '[]'
            ) AS students
       FROM parents p
       LEFT JOIN students s ON s.parent_id = p.id
      GROUP BY p.id, p.name, p.email
      ORDER BY p.name`,
  )
}

export interface BookingDetail extends Booking {
  student_name: string
  parent_name: string
  class_title: string
  class_subject: string
  class_starts_at: string
  price_cents: number
  payment_attempts: PaymentAttempt[]
}

export async function getBookingDetail(id: string): Promise<BookingDetail> {
  const booking = await queryOne<BookingDetail>(
    `SELECT b.*,
            s.name AS student_name,
            p.name AS parent_name,
            c.title AS class_title,
            c.subject AS class_subject,
            c.starts_at AS class_starts_at,
            c.price_cents,
            COALESCE(
              (SELECT json_agg(pa ORDER BY pa.created_at DESC)
                 FROM payment_attempts pa
                WHERE pa.booking_id = b.id),
              '[]'
            ) AS payment_attempts
       FROM bookings b
       JOIN students s      ON s.id = b.student_id
       JOIN parents p       ON p.id = s.parent_id
       JOIN trial_classes c ON c.id = b.trial_class_id
      WHERE b.id = $1`,
    [id],
  )

  if (!booking) {
    throw new BookingError('NOT_FOUND', 'Booking not found', { bookingId: id })
  }
  return booking
}

/**
 * The roster the teaching team works from.
 *
 * Only `confirmed` bookings appear. A child mid-checkout holds a seat but is not
 * on the roster, and a child whose payment failed is on neither.
 */
export async function getClassRoster(trialClassId: string): Promise<ClassRoster> {
  const trialClass = await getTrialClass(trialClassId)
  if (!trialClass) {
    throw new BookingError('NOT_FOUND', 'Trial class not found', { trialClassId })
  }

  const students = await query<ClassRoster['students'][number]>(
    `SELECT b.id          AS booking_id,
            s.id          AS student_id,
            s.name        AS student_name,
            s.grade_level,
            p.name        AS parent_name,
            p.email       AS parent_email,
            b.updated_at  AS confirmed_at
       FROM bookings b
       JOIN students s ON s.id = b.student_id
       JOIN parents p  ON p.id = s.parent_id
      WHERE b.trial_class_id = $1
        AND b.status = 'confirmed'
      ORDER BY b.created_at ASC`,
    [trialClassId],
  )

  return {
    trial_class: trialClass,
    seats_confirmed: students.length,
    seats_available: trialClass.seats_available,
    students,
  }
}

export async function getAllRosters(): Promise<ClassRoster[]> {
  const classes = await listTrialClasses()
  return Promise.all(classes.map((c) => getClassRoster(c.id)))
}
