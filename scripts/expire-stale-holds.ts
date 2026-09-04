/**
 * The background job, as a CLI entry point.
 *
 * In production this runs on a schedule (cron / a queue worker) every minute or
 * so. It is also exposed at POST /api/admin/expire-holds so the behaviour can be
 * demonstrated without waiting for a scheduler.
 *
 *   npm run jobs:expire-holds
 */
import { loadEnv, useTestDatabase } from './env'

loadEnv()
if (process.argv.includes('--test')) useTestDatabase()

async function main() {
  const { expireStaleHolds } = await import('../src/lib/booking/expire-holds')
  const { closePool } = await import('../src/lib/db')
  const { config } = await import('../src/lib/config')

  const report = await expireStaleHolds()

  console.log(`\n  Seat holds older than ${config.seatHoldTimeoutSeconds}s released : ${report.staleSeatHoldsReleased}`)
  console.log(`  Pending bookings older than ${config.pendingBookingTimeoutSeconds}s expired : ${report.abandonedBookingsExpired}\n`)

  await closePool()
}

main().catch((error) => {
  console.error('\nExpiry job failed:\n', error)
  process.exit(1)
})
