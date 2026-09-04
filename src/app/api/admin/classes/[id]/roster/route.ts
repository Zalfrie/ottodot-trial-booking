import { handle } from '@/lib/api'
import { getClassRoster } from '@/lib/booking/queries'

export const dynamic = 'force-dynamic'

/** GET /api/admin/classes/:id/roster - confirmed students for one class. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handle(async () => getClassRoster(id))
}
