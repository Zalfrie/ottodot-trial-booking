import { handle } from '@/lib/api'
import { cancelBooking } from '@/lib/booking/cancel-booking'

export const dynamic = 'force-dynamic'

/** POST /api/bookings/:id/cancel - releases the seat if one was held. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handle(async () => ({ booking: await cancelBooking(id) }))
}
