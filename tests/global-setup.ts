import { Pool } from 'pg'
import { loadEnv } from '../scripts/env'
import { resetDatabase } from '../scripts/reset-lib'

/**
 * Builds the schema in the TEST database once, before any test file runs.
 *
 * Individual tests only reseed (see tests/setup.ts), which is far cheaper than
 * rebuilding the schema between them.
 */
export default async function setup() {
  loadEnv()

  const connectionString = process.env.TEST_DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env.local (see README, "Running the tests").',
    )
  }

  const pool = new Pool({ connectionString })
  try {
    await resetDatabase(pool, { seed: false })
  } catch (error) {
    throw new Error(
      `Could not prepare the test database at ${connectionString.replace(/:[^:@]*@/, ':***@')}.\n` +
        `Is Postgres running? See README, "Getting started".\n\n${String(error)}`,
    )
  } finally {
    await pool.end()
  }
}
