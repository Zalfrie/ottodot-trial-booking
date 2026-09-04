import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Mirrors the order Next.js loads env files in, so a script and the dev server
 * always see the same DATABASE_URL.
 */
export function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    const path = resolve(process.cwd(), file)
    if (existsSync(path)) loadDotenv({ path })
  }
}

/**
 * Point the process at the test database. Called before anything imports the
 * pool, since the pool reads DATABASE_URL once and caches the connection.
 */
export function useTestDatabase(): void {
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. See .env.example.')
  }
  process.env.DATABASE_URL = url
}

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}
