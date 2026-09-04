/**
 * Drops and rebuilds the schema, then loads the synthetic seed data.
 *
 *   npm run db:reset            -> DATABASE_URL
 *   npm run db:reset:test       -> TEST_DATABASE_URL
 *   npm run db:reset -- --no-seed
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnv, redactUrl, useTestDatabase } from './env'

loadEnv()

const args = process.argv.slice(2)
if (args.includes('--test')) useTestDatabase()

const withSeed = !args.includes('--no-seed')

async function main() {
  // Imported after the env is settled so the pool picks up the right URL.
  const { getPool, closePool } = await import('../src/lib/db')

  const schema = readFileSync(resolve(process.cwd(), 'db/schema.sql'), 'utf8')
  const seed = readFileSync(resolve(process.cwd(), 'db/seed.sql'), 'utf8')

  const pool = getPool()
  console.log(`  database : ${redactUrl(process.env.DATABASE_URL ?? '')}`)

  await pool.query(schema)
  console.log('  schema   : rebuilt')

  if (withSeed) {
    await pool.query(seed)
    console.log('  seed     : loaded')
  }

  const { rows } = await pool.query<{
    title: string
    capacity: number
    seats_taken: number
    seats_available: number
  }>(
    'SELECT title, capacity, seats_taken, seats_available FROM trial_class_availability ORDER BY starts_at',
  )

  console.log('\n  Trial classes')
  for (const row of rows) {
    console.log(
      `    ${row.title.padEnd(30)} ${row.seats_taken}/${row.capacity} taken` +
        `  (${row.seats_available} free)`,
    )
  }
  console.log()

  await closePool()
}

main().catch((error) => {
  console.error('\nDatabase reset failed:\n', error)
  process.exit(1)
})
