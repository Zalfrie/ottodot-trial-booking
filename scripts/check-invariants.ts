/**
 * Reconciliation check.
 *
 * The seat counter on trial_classes is denormalised, so something has to prove
 * it still agrees with the bookings it summarises. The test suite asserts the
 * same properties after every concurrency scenario; this script runs them
 * against whatever DATABASE_URL points at, which is what you would wire to an
 * alert in production.
 *
 *   npm run db:check
 *   npm run db:check -- --test
 */
import { loadEnv, useTestDatabase } from './env'

loadEnv()
if (process.argv.includes('--test')) useTestDatabase()

async function main() {
  const { findInvariantViolations, INVARIANT_NAMES } = await import('../src/lib/booking/invariants')
  const { closePool } = await import('../src/lib/db')

  const violations = await findInvariantViolations()
  await closePool()

  if (violations.length === 0) {
    console.log('\n  All invariants hold:')
    for (const name of INVARIANT_NAMES) console.log(`    - ${name}`)
    console.log()
    return
  }

  console.error(`\n  ${violations.length} invariant violation(s):\n`)
  for (const v of violations) console.error(`    [${v.check}] ${v.detail}`)
  console.error()
  process.exit(1)
}

main().catch((error) => {
  console.error('\nInvariant check failed to run:\n', error)
  process.exit(1)
})
