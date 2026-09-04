import { handle } from '@/lib/api'
import { getBookingDetail } from '@/lib/booking/queries'

export const dynamic = 'force-dynamic'

/** GET /api/bookings/:id - booking status plus its payment attempts. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handle(async () => ({ booking: await getBookingDetail(id) }))
}
