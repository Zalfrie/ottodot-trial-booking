import { handle } from '@/lib/api'
import { expireStaleHolds } from '@/lib/booking/expire-holds'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/expire-holds - runs the reaper on demand.
 *
 * The same function runs on a schedule via `npm run jobs:expire-holds`. Exposed
 * here so the behaviour is demonstrable in a walkthrough without waiting for a
 * cron tick. In production this would sit behind admin auth, or not exist at all.
 */
export async function POST() {
  return handle(async () => expireStaleHolds())
}
