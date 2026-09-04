import { handle, readJson } from '@/lib/api'
import { parsePaymentSimulation, payBooking } from '@/lib/booking/pay-booking'

export const dynamic = 'force-dynamic'

/**
 * POST /api/bookings/:id/payment  { simulate?: 'success' | 'failure' | 'slow_success' }
 *
 * Reserves the seat, then charges. Always 200 with an `outcome` the UI can
 * branch on - `class_full` is a legitimate business result of a well-formed
 * request, not a client error:
 *
 *   confirmed       seat won, payment taken, on the roster
 *   payment_failed  card declined, seat released, retryable
 *   class_full      lost the race for the last seat; card never touched
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handle(async () => {
    const simulate = parsePaymentSimulation(await readJson(request))
    return payBooking(id, simulate)
  })
}
