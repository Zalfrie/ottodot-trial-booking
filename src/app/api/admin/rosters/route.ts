import { handle } from '@/lib/api'
import { getAllRosters } from '@/lib/booking/queries'

export const dynamic = 'force-dynamic'

/** GET /api/admin/rosters - every class roster, for the teaching team. */
export async function GET() {
  return handle(async () => ({ rosters: await getAllRosters() }))
}
