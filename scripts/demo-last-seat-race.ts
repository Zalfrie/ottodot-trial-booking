/**
 * Runs the exact scenario from the brief, plus two harder versions of it,
 * against the real database. No HTTP server required.
 *
 *   npm run demo:race
 *
 * Resets the database first, so it is repeatable.
 */
import { loadEnv, useTestDatabase } from './env'

loadEnv()
if (process.argv.includes('--test')) useTestDatabase()

import { resetDatabase, SEED } from './reset-lib'

const CHECK = '  [ok]'
const CROSS = '  [!!]'

function heading(text: string) {
  console.log(`\n${'-'.repeat(74)}\n  ${text}\n${'-'.repeat(74)}`)
}

async function main() {
  const { getPool, closePool, queryOne } = await import('../src/lib/db')
  const { createBooking } = await import('../src/lib/booking/create-booking')
  const { payBooking } = await import('../src/lib/booking/pay-booking')
  const { getClassRoster } = await import('../src/lib/booking/queries')
  const { BookingError } = await import('../src/lib/errors')

  const pool = getPool()
  let failures = 0

  const seats = async (classId: string) => {
    const row = await queryOne<{
      seats_taken: number
      capacity: number
      confirmed_count: string
    }>('SELECT seats_taken, capacity, confirmed_count FROM trial_class_availability WHERE id = $1', [
      classId,
    ])
    return `${row!.seats_taken}/${row!.capacity} seats taken, ${row!.confirmed_count} confirmed`
  }

  const expect = (label: string, condition: boolean) => {
    console.log(`${condition ? CHECK : CROSS} ${label}`)
    if (!condition) failures += 1
  }

  // =========================================================================
  heading('ACT 1  -  The scenario from the brief (sequential, as written)')
  // =========================================================================
  await resetDatabase(pool)

  const cls = SEED.classes.lastSeatMath
  console.log(`\n  Class "Fractions Bootcamp" starts at ${await seats(cls)}.`)
  console.log('  One seat left. Two parents are about to want it.\n')

  console.log('  1. User A (Zara) selects the last slot and moves to payment.')
  const bookingA = await createBooking({ studentId: SEED.students.zara, trialClassId: cls })
  console.log(`     -> booking ${bookingA.id.slice(0, 8)} is ${bookingA.status}`)

  console.log('  2. User B (Omar) selects the same slot.')
  const bookingB = await createBooking({ studentId: SEED.students.omar, trialClassId: cls })
  console.log(`     -> booking ${bookingB.id.slice(0, 8)} is ${bookingB.status}`)
  console.log(`     -> ${await seats(cls)}  (pending bookings hold no seat)\n`)

  console.log('  3. User B completes payment first.')
  const resultB = await payBooking(bookingB.id, 'success')
  console.log(`     -> ${resultB.outcome}   (${await seats(cls)})\n`)

  console.log('  4. User A now tries to complete payment.')
  const resultA = await payBooking(bookingA.id, 'success')
  console.log(`     -> ${resultA.outcome}`)
  if (resultA.outcome === 'class_full') {
    console.log(`     -> booking marked ${resultA.booking.status} / ${resultA.booking.cancellation_reason}`)
  }

  const attemptsA = await queryOne<{ n: string }>(
    'SELECT count(*) AS n FROM payment_attempts WHERE booking_id = $1',
    [bookingA.id],
  )

  console.log()
  expect('User B is confirmed', resultB.outcome === 'confirmed')
  expect('User A is NOT confirmed', resultA.outcome === 'class_full')
  expect("User A's card was never charged", attemptsA!.n === '0')
  expect('Class is at exactly 4/4', (await seats(cls)).startsWith('4/4'))

  const roster1 = await getClassRoster(cls)
  expect('Roster holds exactly 4 students', roster1.students.length === 4)
  console.log(`\n  Roster: ${roster1.students.map((s) => s.student_name).join(', ')}`)

  // =========================================================================
  heading('ACT 2  -  The same race, but genuinely simultaneous')
  // =========================================================================
  await resetDatabase(pool)
  console.log('\n  Both parents hit "Pay" at the same instant on the last seat.\n')

  const a2 = await createBooking({ studentId: SEED.students.zara, trialClassId: cls })
  const b2 = await createBooking({ studentId: SEED.students.omar, trialClassId: cls })

  const [outA, outB] = await Promise.all([
    payBooking(a2.id, 'success'),
    payBooking(b2.id, 'success'),
  ])

  const confirmedCount = [outA, outB].filter((r) => r.outcome === 'confirmed').length
  const fullCount = [outA, outB].filter((r) => r.outcome === 'class_full').length
  console.log(`  Zara -> ${outA.outcome}`)
  console.log(`  Omar -> ${outB.outcome}\n`)

  expect('Exactly one parent won the seat', confirmedCount === 1)
  expect('Exactly one parent was told the class is full', fullCount === 1)
  expect('Class is at exactly 4/4', (await seats(cls)).startsWith('4/4'))

  // =========================================================================
  heading('ACT 3  -  Stampede: 5 parents, 4 seats, all at once')
  // =========================================================================
  await resetDatabase(pool)

  const open = SEED.classes.openScience
  console.log(`\n  Class "Forces & Motion" is empty (${await seats(open)}).`)
  console.log('  All five children try to book and pay concurrently.\n')

  const everyone = Object.entries(SEED.students)
  const bookings = await Promise.all(
    everyone.map(([, id]) => createBooking({ studentId: id, trialClassId: open })),
  )
  const outcomes = await Promise.all(bookings.map((b) => payBooking(b.id, 'success')))

  for (const [i, outcome] of outcomes.entries()) {
    console.log(`  ${everyone[i]![0].padEnd(7)} -> ${outcome.outcome}`)
  }

  const confirmed = outcomes.filter((o) => o.outcome === 'confirmed').length
  const rejected = outcomes.filter((o) => o.outcome === 'class_full').length
  console.log()
  expect('Exactly 4 confirmed', confirmed === 4)
  expect('Exactly 1 rejected as full', rejected === 1)
  expect('Class is at exactly 4/4', (await seats(open)).startsWith('4/4'))

  // =========================================================================
  heading('ACT 4  -  Payment failure and duplicate booking')
  // =========================================================================
  await resetDatabase(pool)

  console.log('\n  A declined card must not put the child on the roster.\n')
  const failing = await createBooking({ studentId: SEED.students.zara, trialClassId: open })
  const failed = await payBooking(failing.id, 'failure')
  console.log(`  Zara pays with a declining card -> ${failed.outcome}`)

  const rosterAfterFailure = await getClassRoster(open)
  expect('Booking is payment_failed', failed.outcome === 'payment_failed')
  expect('Zara is NOT on the roster', rosterAfterFailure.students.length === 0)
  expect('The seat was released', (await seats(open)).startsWith('0/4'))

  console.log('\n  She retries with a good card.')
  const retried = await payBooking(failing.id, 'success')
  console.log(`  -> ${retried.outcome}`)
  expect('Retry succeeds on the same booking', retried.outcome === 'confirmed')
  expect('Now on the roster', (await getClassRoster(open)).students.length === 1)

  console.log('\n  She then tries to book the same class a second time.')
  let duplicateRejected = false
  try {
    await createBooking({ studentId: SEED.students.zara, trialClassId: open })
  } catch (error) {
    if (error instanceof BookingError && error.code === 'DUPLICATE_BOOKING') {
      duplicateRejected = true
      console.log(`  -> rejected: ${error.message}`)
    } else {
      throw error
    }
  }
  expect('Duplicate booking rejected', duplicateRejected)
  expect('Still only 1 seat taken', (await seats(open)).startsWith('1/4'))

  // =========================================================================
  heading('RESULT')
  // =========================================================================
  await closePool()

  if (failures > 0) {
    console.error(`\n  ${failures} assertion(s) FAILED\n`)
    process.exit(1)
  }
  console.log('\n  Every assertion passed. At most one confirmed booking per seat.\n')
}

main().catch((error) => {
  console.error('\nDemo failed:\n', error)
  process.exit(1)
})
