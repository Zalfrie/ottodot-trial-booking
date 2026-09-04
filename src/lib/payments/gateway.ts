/**
 * Mock payment gateway.
 *
 * A real integration (Stripe et al.) would live behind this same interface: take
 * an amount and an idempotency key, return success or a decline reason. Nothing
 * in the booking logic knows it is a mock, so swapping it out is a one-file job.
 *
 * The outcome is caller-supplied rather than random so that tests, the demo
 * script and a live click-through all produce the exact case being shown.
 */

export type PaymentSimulation = 'success' | 'failure' | 'slow_success' | 'slow_failure'

export const PAYMENT_SIMULATIONS: readonly PaymentSimulation[] = [
  'success',
  'failure',
  'slow_success',
  'slow_failure',
]

export function isPaymentSimulation(value: unknown): value is PaymentSimulation {
  return typeof value === 'string' && (PAYMENT_SIMULATIONS as readonly string[]).includes(value)
}

export type PaymentResult =
  | { status: 'succeeded'; providerRef: string }
  | { status: 'failed'; providerRef: string; failureReason: string }

export interface ChargeRequest {
  amountCents: number
  currency: string
  /**
   * Sent to the provider so a retried charge is not a second charge. Here it
   * simply becomes part of the reference, but it is threaded through to keep the
   * shape honest.
   */
  idempotencyKey: string
  simulate: PaymentSimulation
}

/** How long `slow_success` stalls, in ms. Long enough to lose a race on purpose. */
export const SLOW_PAYMENT_DELAY_MS = 1_500

export async function charge(request: ChargeRequest): Promise<PaymentResult> {
  const providerRef = `mock_pi_${request.idempotencyKey.slice(0, 8)}_${Date.now().toString(36)}`

  if (request.simulate === 'slow_success' || request.simulate === 'slow_failure') {
    // Widens the window between "seat reserved" and "payment settled" so the
    // last-seat race is reproducible by hand, not just under load - and so the
    // tests can fire the seat-hold reaper while a charge is genuinely in flight.
    await new Promise((resolve) => setTimeout(resolve, SLOW_PAYMENT_DELAY_MS))
  }

  if (request.simulate === 'failure' || request.simulate === 'slow_failure') {
    return { status: 'failed', providerRef, failureReason: 'card_declined' }
  }

  return { status: 'succeeded', providerRef }
}
