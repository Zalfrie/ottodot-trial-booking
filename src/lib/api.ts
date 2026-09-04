import { NextResponse } from 'next/server'
import { BookingError } from './errors'

/**
 * One place where domain errors become HTTP responses, so every route reports
 * failures in the same shape:
 *
 *   { "error": { "code": "CLASS_FULL", "message": "...", "details": { ... } } }
 */
export async function handle<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn())
  } catch (error) {
    if (error instanceof BookingError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        { status: error.httpStatus },
      )
    }

    // Anything else is a bug or an outage: log it in full, tell the client nothing.
    console.error('[api] unhandled error', error)
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } },
      { status: 500 },
    )
  }
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new BookingError('VALIDATION_ERROR', 'Request body must be valid JSON')
  }
}
