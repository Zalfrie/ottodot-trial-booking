import { handle } from '@/lib/api'
import { listParentsWithStudents } from '@/lib/booking/queries'

export const dynamic = 'force-dynamic'

/**
 * GET /api/parents - parents with their children.
 *
 * Stands in for "the signed-in parent and their children". There is no auth in
 * this slice; see README, "What I deliberately cut".
 */
export async function GET() {
  return handle(async () => ({ parents: await listParentsWithStudents() }))
}
