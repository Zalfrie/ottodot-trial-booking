export type BookingStatus =
  | 'pending_payment'
  | 'processing_payment'
  | 'confirmed'
  | 'payment_failed'
  | 'cancelled'
  | 'expired'

export type PaymentAttemptStatus = 'succeeded' | 'failed'

/** Statuses that reserve a seat. Must stay in sync with db/schema.sql. */
export const SEAT_HOLDING_STATUSES: readonly BookingStatus[] = ['processing_payment', 'confirmed']

/** Statuses covered by the partial unique index (i.e. block a re-booking). */
export const ACTIVE_STATUSES: readonly BookingStatus[] = [
  'pending_payment',
  'processing_payment',
  'confirmed',
]

export interface Parent {
  id: string
  name: string
  email: string
}

export interface Student {
  id: string
  parent_id: string
  name: string
  grade_level: number
}

export interface TrialClassAvailability {
  id: string
  subject: string
  title: string
  teacher_name: string
  starts_at: string
  duration_minutes: number
  price_cents: number
  capacity: number
  seats_taken: number
  seats_available: number
  confirmed_count: number
  in_flight_count: number
}

export interface Booking {
  id: string
  student_id: string
  trial_class_id: string
  status: BookingStatus
  seat_held_at: string | null
  cancellation_reason: string | null
  created_at: string
  updated_at: string
}

export interface PaymentAttempt {
  id: string
  booking_id: string
  amount_cents: number
  currency: string
  status: PaymentAttemptStatus
  provider_ref: string | null
  failure_reason: string | null
  created_at: string
}

export interface RosterEntry {
  booking_id: string
  student_id: string
  student_name: string
  grade_level: number
  parent_name: string
  parent_email: string
  confirmed_at: string
}

export interface ClassRoster {
  trial_class: TrialClassAvailability
  seats_confirmed: number
  seats_available: number
  students: RosterEntry[]
}
