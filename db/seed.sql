-- ---------------------------------------------------------------------------
-- Ottodot trial booking - synthetic seed data
--
-- IDs are fixed and readable so the README, the tests and the demo script can
-- all refer to the same rows. `starts_at` is relative to now() so the classes
-- never drift into the past.
--
-- The four situations the brief asks to demonstrate:
--
--   SCI-101  4 seats free      -> a class with available seats
--   MTH-201  3 confirmed       -> the LAST-SEAT class, used by `npm run demo:race`
--   SCI-301  4 confirmed       -> already full
--   MTH-401  1 confirmed       -> Zara is confirmed (duplicate-attempt case) and
--                                 Omar has a payment_failed booking (retry case)
-- ---------------------------------------------------------------------------

TRUNCATE payment_attempts, bookings, trial_classes, students, parents RESTART IDENTITY CASCADE;

-- Parents ---------------------------------------------------------------------
INSERT INTO parents (id, name, email) VALUES
  ('11111111-1111-1111-1111-111111111001', 'Aisha Rahman',  'aisha@example.com'),
  ('11111111-1111-1111-1111-111111111002', 'Ben Tan',       'ben@example.com'),
  ('11111111-1111-1111-1111-111111111003', 'Chandra Devi',  'chandra@example.com');

-- Students --------------------------------------------------------------------
INSERT INTO students (id, parent_id, name, grade_level) VALUES
  ('22222222-2222-2222-2222-222222222001', '11111111-1111-1111-1111-111111111001', 'Zara Rahman',  4),
  ('22222222-2222-2222-2222-222222222002', '11111111-1111-1111-1111-111111111001', 'Omar Rahman',  6),
  ('22222222-2222-2222-2222-222222222003', '11111111-1111-1111-1111-111111111002', 'Ethan Tan',    3),
  ('22222222-2222-2222-2222-222222222004', '11111111-1111-1111-1111-111111111002', 'Mei Tan',      5),
  ('22222222-2222-2222-2222-222222222005', '11111111-1111-1111-1111-111111111003', 'Kiran Devi',   4);

-- Trial classes ---------------------------------------------------------------
-- seats_taken is written explicitly here to match the bookings inserted below;
-- `npm run db:check` asserts the two agree.
INSERT INTO trial_classes
  (id, subject, title, teacher_name, starts_at, duration_minutes, price_cents, capacity, seats_taken) VALUES
  ('33333333-3333-3333-3333-333333333001', 'Science', 'Forces & Motion (Trial)',    'Ms. Priya',  now() + interval '2 days',  45, 2900, 4, 0),
  ('33333333-3333-3333-3333-333333333002', 'Math',    'Fractions Bootcamp (Trial)', 'Mr. Daniel', now() + interval '3 days',  45, 2900, 4, 3),
  ('33333333-3333-3333-3333-333333333003', 'Science', 'The Human Body (Trial)',     'Ms. Priya',  now() + interval '4 days',  45, 2900, 4, 4),
  ('33333333-3333-3333-3333-333333333004', 'Math',    'Speed & Ratio (Trial)',      'Mr. Daniel', now() + interval '5 days',  45, 2900, 4, 1);

-- Bookings --------------------------------------------------------------------

-- MTH-201: exactly 3 confirmed -> one seat left. This is the race-condition class.
INSERT INTO bookings (id, student_id, trial_class_id, status, seat_held_at, created_at) VALUES
  ('44444444-4444-4444-4444-444444444001', '22222222-2222-2222-2222-222222222003', '33333333-3333-3333-3333-333333333002', 'confirmed', now() - interval '3 days', now() - interval '3 days'),
  ('44444444-4444-4444-4444-444444444002', '22222222-2222-2222-2222-222222222004', '33333333-3333-3333-3333-333333333002', 'confirmed', now() - interval '3 days', now() - interval '3 days'),
  ('44444444-4444-4444-4444-444444444003', '22222222-2222-2222-2222-222222222005', '33333333-3333-3333-3333-333333333002', 'confirmed', now() - interval '2 days', now() - interval '2 days');

-- SCI-301: full.
INSERT INTO bookings (id, student_id, trial_class_id, status, seat_held_at, created_at) VALUES
  ('44444444-4444-4444-4444-444444444004', '22222222-2222-2222-2222-222222222001', '33333333-3333-3333-3333-333333333003', 'confirmed', now() - interval '5 days', now() - interval '5 days'),
  ('44444444-4444-4444-4444-444444444005', '22222222-2222-2222-2222-222222222002', '33333333-3333-3333-3333-333333333003', 'confirmed', now() - interval '5 days', now() - interval '5 days'),
  ('44444444-4444-4444-4444-444444444006', '22222222-2222-2222-2222-222222222003', '33333333-3333-3333-3333-333333333003', 'confirmed', now() - interval '4 days', now() - interval '4 days'),
  ('44444444-4444-4444-4444-444444444007', '22222222-2222-2222-2222-222222222004', '33333333-3333-3333-3333-333333333003', 'confirmed', now() - interval '4 days', now() - interval '4 days');

-- MTH-401: Zara is already confirmed. Booking her into this class again must be
-- rejected as a duplicate (the partial unique index refuses it).
INSERT INTO bookings (id, student_id, trial_class_id, status, seat_held_at, created_at) VALUES
  ('44444444-4444-4444-4444-444444444008', '22222222-2222-2222-2222-222222222001', '33333333-3333-3333-3333-333333333004', 'confirmed', now() - interval '1 day', now() - interval '1 day');

-- MTH-401: Omar's card was declined. He holds NO seat and, because
-- 'payment_failed' sits outside the partial unique index, he is free to retry.
INSERT INTO bookings (id, student_id, trial_class_id, status, seat_held_at, cancellation_reason, created_at) VALUES
  ('44444444-4444-4444-4444-444444444009', '22222222-2222-2222-2222-222222222002', '33333333-3333-3333-3333-333333333004', 'payment_failed', NULL, 'payment_failed', now() - interval '6 hours');

-- Payment attempts ------------------------------------------------------------
INSERT INTO payment_attempts (booking_id, amount_cents, currency, status, provider_ref, created_at)
SELECT b.id, 2900, 'SGD', 'succeeded', 'mock_pi_seed_' || left(b.id::text, 8), b.created_at
FROM bookings b
WHERE b.status = 'confirmed';

INSERT INTO payment_attempts (booking_id, amount_cents, currency, status, failure_reason, provider_ref, created_at) VALUES
  ('44444444-4444-4444-4444-444444444009', 2900, 'SGD', 'failed', 'card_declined', 'mock_pi_seed_declined', now() - interval '6 hours');
