-- ---------------------------------------------------------------------------
-- Ottodot trial booking - schema
--
-- Design note: the two invariants that matter are enforced by the DATABASE, not
-- by application code, so they hold even if a future endpoint forgets to check:
--
--   1. "never more than `capacity` seats taken"  -> CHECK on trial_classes
--   2. "one active booking per (student, class)" -> partial UNIQUE INDEX
--
-- Application code is the first line of defence (nice errors, no wasted work);
-- these constraints are the line that cannot be argued with.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS payment_attempts CASCADE;
DROP TABLE IF EXISTS bookings CASCADE;
DROP TABLE IF EXISTS trial_classes CASCADE;
DROP TABLE IF EXISTS students CASCADE;
DROP TABLE IF EXISTS parents CASCADE;
DROP TYPE IF EXISTS booking_status CASCADE;
DROP TYPE IF EXISTS payment_attempt_status CASCADE;

-- No extension needed: gen_random_uuid() is built into Postgres 13+, so the
-- schema installs as a plain database owner with no superuser step.

-- ---------------------------------------------------------------------------
-- Booking lifecycle
--
--   pending_payment     booking created, NO seat reserved yet
--   processing_payment  seat reserved, charge in flight  (transient, reaped)
--   confirmed           seat reserved, payment succeeded -> on the roster
--   payment_failed      seat released, parent may retry
--   cancelled           seat released; see cancellation_reason (e.g. class_full)
--   expired             abandoned, reaped by the background job; seat released
--
-- Seats are held by `processing_payment` and `confirmed` only. `pending_payment`
-- deliberately holds nothing - see README, "Why pending_payment does not hold a seat".
-- ---------------------------------------------------------------------------
CREATE TYPE booking_status AS ENUM (
  'pending_payment',
  'processing_payment',
  'confirmed',
  'payment_failed',
  'cancelled',
  'expired'
);

CREATE TYPE payment_attempt_status AS ENUM ('succeeded', 'failed');

CREATE TABLE parents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE students (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid NOT NULL REFERENCES parents (id) ON DELETE CASCADE,
  name        text NOT NULL,
  grade_level int  NOT NULL CHECK (grade_level BETWEEN 1 AND 12),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX students_parent_id_idx ON students (parent_id);

CREATE TABLE trial_classes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject          text NOT NULL,
  title            text NOT NULL,
  teacher_name     text NOT NULL,
  starts_at        timestamptz NOT NULL,
  duration_minutes int  NOT NULL DEFAULT 45 CHECK (duration_minutes > 0),
  price_cents      int  NOT NULL CHECK (price_cents >= 0),

  capacity         int  NOT NULL DEFAULT 4 CHECK (capacity > 0),

  -- Denormalised seat counter. Kept in the SAME transaction as every booking
  -- state change that takes or releases a seat, so it is never "eventually"
  -- correct - it is correct or the transaction aborted.
  --
  -- It exists so that taking the last seat is a single atomic statement
  -- (`UPDATE ... WHERE seats_taken < capacity`) that row-locks this class and
  -- nothing else. Counting bookings under a lock would work too but serialises
  -- on a growing set of rows instead of exactly one.
  seats_taken      int  NOT NULL DEFAULT 0,

  created_at       timestamptz NOT NULL DEFAULT now(),

  -- THE overbooking invariant. Nothing in the application can violate this and
  -- still commit.
  CONSTRAINT trial_classes_seats_within_capacity
    CHECK (seats_taken >= 0 AND seats_taken <= capacity)
);

CREATE INDEX trial_classes_starts_at_idx ON trial_classes (starts_at);

CREATE TABLE bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id          uuid NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  trial_class_id      uuid NOT NULL REFERENCES trial_classes (id) ON DELETE CASCADE,
  status              booking_status NOT NULL DEFAULT 'pending_payment',

  -- Set when the seat is reserved (entering processing_payment), cleared when
  -- the seat is released. The reaper uses it to find crashed checkouts.
  seat_held_at        timestamptz,

  -- Machine-readable reason for a non-happy ending: 'class_full',
  -- 'payment_failed', 'abandoned', 'requested_by_parent', 'stale_seat_hold'.
  cancellation_reason text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- A seat is held exactly by these two states, so the timestamp must agree.
  CONSTRAINT bookings_seat_hold_matches_status CHECK (
    (status IN ('processing_payment', 'confirmed') AND seat_held_at IS NOT NULL)
    OR
    (status NOT IN ('processing_payment', 'confirmed') AND seat_held_at IS NULL)
  )
);

-- THE duplicate-booking invariant.
--
-- Partial, so it only constrains bookings that are still "live". A parent whose
-- payment failed, or who cancelled, can book the same class again - those rows
-- are outside the index.
CREATE UNIQUE INDEX bookings_one_active_per_student_class
  ON bookings (student_id, trial_class_id)
  WHERE status IN ('pending_payment', 'processing_payment', 'confirmed');

CREATE INDEX bookings_trial_class_id_status_idx ON bookings (trial_class_id, status);
CREATE INDEX bookings_student_id_idx ON bookings (student_id);

-- Lets the reaper find stale seat holds without scanning every booking.
CREATE INDEX bookings_seat_held_at_idx
  ON bookings (seat_held_at)
  WHERE status = 'processing_payment';

CREATE TABLE payment_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  amount_cents   int  NOT NULL CHECK (amount_cents >= 0),
  currency       text NOT NULL DEFAULT 'SGD',
  status         payment_attempt_status NOT NULL,
  provider_ref   text,
  failure_reason text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_attempts_booking_id_idx ON payment_attempts (booking_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Read model for rosters and availability.
--
-- `seats_taken` includes in-flight payments, so a parent browsing sees the
-- pessimistic (safe) number of free seats. The roster itself only ever lists
-- confirmed students.
-- ---------------------------------------------------------------------------
CREATE VIEW trial_class_availability AS
SELECT
  c.id,
  c.subject,
  c.title,
  c.teacher_name,
  c.starts_at,
  c.duration_minutes,
  c.price_cents,
  c.capacity,
  c.seats_taken,
  (c.capacity - c.seats_taken)                                     AS seats_available,
  (SELECT count(*) FROM bookings b
    WHERE b.trial_class_id = c.id AND b.status = 'confirmed')      AS confirmed_count,
  (SELECT count(*) FROM bookings b
    WHERE b.trial_class_id = c.id
      AND b.status = 'processing_payment')                         AS in_flight_count
FROM trial_classes c;
