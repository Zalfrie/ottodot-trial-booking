import Link from 'next/link'
import { getAllRosters } from '@/lib/booking/queries'

export const dynamic = 'force-dynamic'

/**
 * Server component: reads the rosters straight from the database on every
 * request. The same data is available as JSON at /api/admin/rosters.
 */
export default async function AdminPage() {
  const rosters = await getAllRosters()

  return (
    <main>
      <h1>Trial class rosters</h1>
      <p className="subtitle">
        Only <strong>confirmed</strong> students appear here. A child mid-checkout holds a seat but
        is not on the roster; a child whose payment failed is on neither.
      </p>

      {rosters.map((roster) => {
        const cls = roster.trial_class
        const full = cls.seats_available <= 0
        return (
          <section key={cls.id} className="card">
            <div className="row">
              <div>
                <strong>{cls.title}</strong>
                <div className="muted">
                  {cls.subject} &middot; {cls.teacher_name} &middot;{' '}
                  {new Date(cls.starts_at).toLocaleString()}
                </div>
              </div>
              <span className={`badge ${full ? 'bad' : 'ok'}`}>
                {roster.seats_confirmed}/{cls.capacity} confirmed
              </span>
            </div>

            {cls.in_flight_count > 0 && (
              <p className="muted">
                {cls.in_flight_count} seat{cls.in_flight_count === 1 ? '' : 's'} reserved for a
                payment in progress.
              </p>
            )}

            {roster.students.length === 0 ? (
              <p className="empty">No confirmed students yet.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Grade</th>
                      <th>Parent</th>
                      <th>Contact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.students.map((student) => (
                      <tr key={student.booking_id}>
                        <td>{student.student_name}</td>
                        <td>{student.grade_level}</td>
                        <td>{student.parent_name}</td>
                        <td className="muted">{student.parent_email}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
              JSON: <code>GET /api/admin/classes/{cls.id}/roster</code>
            </p>
          </section>
        )
      })}

      <div className="actions">
        <Link href="/">
          <button type="button">Book a trial</button>
        </Link>
      </div>
    </main>
  )
}
