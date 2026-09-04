import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Pool } from 'pg'

let schemaSql: string | undefined
let seedSql: string | undefined

function read(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

/**
 * Rebuilds the schema and reloads the seed data on an existing pool.
 *
 * Shared by `npm run db:reset`, the demo script and the test suite so there is
 * exactly one definition of "a freshly seeded database".
 */
export async function resetDatabase(pool: Pool, options: { seed?: boolean } = {}): Promise<void> {
  schemaSql ??= read('db/schema.sql')
  seedSql ??= read('db/seed.sql')

  await pool.query(schemaSql)
  if (options.seed !== false) {
    await pool.query(seedSql)
  }
}

/** Reloads seed data only. Much faster than a full rebuild between tests. */
export async function reseed(pool: Pool): Promise<void> {
  seedSql ??= read('db/seed.sql')
  await pool.query(seedSql)
}

/** Fixed IDs from db/seed.sql, so tests and demos never hard-code UUIDs inline. */
export const SEED = {
  parents: {
    aisha: '11111111-1111-1111-1111-111111111001',
    ben: '11111111-1111-1111-1111-111111111002',
    chandra: '11111111-1111-1111-1111-111111111003',
  },
  students: {
    zara: '22222222-2222-2222-2222-222222222001',
    omar: '22222222-2222-2222-2222-222222222002',
    ethan: '22222222-2222-2222-2222-222222222003',
    mei: '22222222-2222-2222-2222-222222222004',
    kiran: '22222222-2222-2222-2222-222222222005',
  },
  classes: {
    /** 4 seats free. */
    openScience: '33333333-3333-3333-3333-333333333001',
    /** 3 confirmed, 1 seat free - the last-seat race class. */
    lastSeatMath: '33333333-3333-3333-3333-333333333002',
    /** 4 confirmed - already full. */
    fullScience: '33333333-3333-3333-3333-333333333003',
    /** Zara confirmed (duplicate case), Omar payment_failed (retry case). */
    duplicateMath: '33333333-3333-3333-3333-333333333004',
  },
  bookings: {
    zaraConfirmedOnDuplicateMath: '44444444-4444-4444-4444-444444444008',
    omarFailedOnDuplicateMath: '44444444-4444-4444-4444-444444444009',
  },
} as const
