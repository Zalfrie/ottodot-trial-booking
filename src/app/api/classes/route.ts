import { handle } from '@/lib/api'
import { listTrialClasses } from '@/lib/booking/queries'

export const dynamic = 'force-dynamic'

/** GET /api/classes - every trial class with live seat availability. */
export async function GET() {
  return handle(async () => ({ classes: await listTrialClasses() }))
}
