import { Pool, type PoolClient, type QueryResultRow } from 'pg'

let pool: Pool | undefined

function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local (see README, "Getting started").',
    )
  }
  return url
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      // The concurrency tests fire a burst of simultaneous checkouts; a pool
      // smaller than that burst would serialise them in the client and hide the
      // very race we are trying to prove is handled.
      max: 20,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    })
  }
  return pool
}

export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool
    pool = undefined
    await closing.end()
  }
}

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params)
  return result.rows
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params)
  return rows[0]
}

/**
 * Runs `fn` inside a transaction, committing on return and rolling back on throw.
 *
 * Every seat-accounting change goes through this. Note what is deliberately NOT
 * inside it: the call to the payment provider. Holding a row lock across a
 * third-party network call would make the slowest card in the queue the upper
 * bound on how fast the class can fill.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // A rollback failure means the connection is already broken; surface the
      // original error rather than masking it.
    }
    throw error
  } finally {
    client.release()
  }
}
