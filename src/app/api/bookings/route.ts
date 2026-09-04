import { handle, readJson } from '@/lib/api'
import { createBooking, parseCreateBookingInput } from '@/lib/booking/create-booking'

export const dynamic = 'force-dynamic'

/**
 * POST /api/bookings  { studentId, trialClassId }
 *
 * Creates a `pending_payment` booking. Reserves no seat.
 *
 * 409 DUPLICATE_BOOKING - this child already has an active booking here
 * 409 CLASS_FULL        - advisory; the class was already full
 */
export async function POST(request: Request) {
  return handle(async () => {
    const input = parseCreateBookingInput(await readJson(request))
    return { booking: await createBooking(input) }
  })
}
