function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`)
  }
  return parsed
}

export const config = {
  /**
   * How long a seat may stay reserved for a payment that is in flight before the
   * reaper reclaims it. This only matters when a process dies mid-checkout - the
   * happy and unhappy paths both release the seat themselves.
   */
  get seatHoldTimeoutSeconds() {
    return intFromEnv('SEAT_HOLD_TIMEOUT_SECONDS', 300)
  },

  /** How long an untouched `pending_payment` booking survives before expiry. */
  get pendingBookingTimeoutSeconds() {
    return intFromEnv('PENDING_BOOKING_TIMEOUT_SECONDS', 1800)
  },
}
