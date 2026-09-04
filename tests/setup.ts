import { afterAll } from 'vitest'
import { loadEnv, useTestDatabase } from '../scripts/env'

// Runs in every test worker before the test file is evaluated. The pool reads
// DATABASE_URL lazily on first use, so pointing it at the test database here is
// enough to keep `npm test` away from the database you are demoing in.
loadEnv()
useTestDatabase()

afterAll(async () => {
  const { closePool } = await import('../src/lib/db')
  await closePool()
})
