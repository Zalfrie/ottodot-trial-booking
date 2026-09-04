/**
 * Error codes that cross the API boundary. Kept as a closed union so the UI can
 * branch on them without string-matching messages.
 */
export type BookingErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'DUPLICATE_BOOKING'
  | 'CLASS_FULL'
  | 'INVALID_STATE'

const HTTP_STATUS: Record<BookingErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  DUPLICATE_BOOKING: 409,
  CLASS_FULL: 409,
  INVALID_STATE: 409,
}

export class BookingError extends Error {
  readonly code: BookingErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: BookingErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'BookingError'
    this.code = code
    this.details = details
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code]
  }
}

/** Postgres SQLSTATE for a unique-constraint violation. */
export const PG_UNIQUE_VIOLATION = '23505'

/** Postgres SQLSTATE for a CHECK-constraint violation. */
export const PG_CHECK_VIOLATION = '23514'

export function isPgError(error: unknown, sqlState: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === sqlState
  )
}
