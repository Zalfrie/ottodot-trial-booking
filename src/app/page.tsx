'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Parent, Student, TrialClassAvailability } from '@/lib/booking/types'
import type { PaymentSimulation } from '@/lib/payments/gateway'

type ParentWithStudents = Parent & { students: Student[] }

interface ApiError {
  error: { code: string; message: string }
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function seatBadge(cls: TrialClassAvailability) {
  if (cls.seats_available <= 0) return <span className="badge bad">Full</span>
  if (cls.seats_available === 1) return <span className="badge warn">Last seat</span>
  return <span className="badge ok">{cls.seats_available} seats left</span>
}

export default function BookTrialPage() {
  const router = useRouter()
  const [parents, setParents] = useState<ParentWithStudents[]>([])
  const [classes, setClasses] = useState<TrialClassAvailability[]>([])
  const [studentId, setStudentId] = useState<string>()
  const [classId, setClassId] = useState<string>()
  const [simulate, setSimulate] = useState<PaymentSimulation>('success')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([
      fetch('/api/parents').then((r) => r.json()),
      fetch('/api/classes').then((r) => r.json()),
    ])
    setParents(p.parents)
    setClasses(c.classes)
  }, [])

  useEffect(() => {
    load().catch(() => setError('Could not load data. Is the database seeded? See the README.'))
  }, [load])

  async function book() {
    if (!studentId || !classId) return
    setBusy(true)
    setError(undefined)

    try {
      const response = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ studentId, trialClassId: classId }),
      })

      if (!response.ok) {
        const body = (await response.json()) as ApiError
        setError(`${body.error.code}: ${body.error.message}`)
        await load()
        return
      }

      const { booking } = await response.json()
      // The seat is NOT reserved yet - it is won on the payment page.
      router.push(`/bookings/${booking.id}?simulate=${simulate}`)
    } catch {
      setError('Network error. Is the dev server still running?')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>Book a trial class</h1>
      <p className="subtitle">
        Trial classes are capped at 4 students. Seats are won at payment, not when you start
        checkout &mdash; so the seat count below is the safe (pessimistic) number.
      </p>

      {error && <div className="error">{error}</div>}

      <h2>1. Choose a child</h2>
      {parents.length === 0 && <p className="empty">Loading&hellip;</p>}
      {parents.map((parent) => (
        <div key={parent.id} style={{ marginBottom: 16 }}>
          <h3>
            {parent.name} <span className="muted">{parent.email}</span>
          </h3>
          {parent.students.map((student) => (
            <button
              key={student.id}
              type="button"
              className="choice card"
              aria-pressed={studentId === student.id}
              onClick={() => setStudentId(student.id)}
            >
              {student.name} <span className="muted">Grade {student.grade_level}</span>
            </button>
          ))}
        </div>
      ))}

      <h2>2. Pick a trial class</h2>
      <div className="grid">
        {classes.map((cls) => {
          const full = cls.seats_available <= 0
          return (
            <button
              key={cls.id}
              type="button"
              className={`card choice${full ? ' disabled' : ''}`}
              aria-pressed={classId === cls.id}
              disabled={full}
              onClick={() => setClassId(cls.id)}
            >
              <div className="row">
                <strong>{cls.title}</strong>
                {seatBadge(cls)}
              </div>
              <div className="muted">
                {cls.subject} &middot; {cls.teacher_name}
              </div>
              <div className="muted">{formatWhen(cls.starts_at)}</div>
              <div className="muted">
                {cls.confirmed_count} confirmed
                {cls.in_flight_count > 0 && `, ${cls.in_flight_count} paying now`} &middot; S$
                {(cls.price_cents / 100).toFixed(2)}
              </div>
            </button>
          )
        })}
      </div>

      <h2>3. Payment outcome to simulate</h2>
      <p className="muted">
        The gateway is a mock. Choosing the outcome here is what makes the edge cases
        demonstrable. <code>slow_success</code> holds the seat for 1.5s, which is long enough to
        open a second tab and lose the race on purpose.
      </p>
      <div className="actions" style={{ marginTop: 8 }}>
        {(['success', 'failure', 'slow_success'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={simulate === option}
            className={simulate === option ? 'primary' : ''}
            onClick={() => setSimulate(option)}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!studentId || !classId || busy}
          onClick={book}
        >
          {busy ? 'Starting checkout…' : 'Start checkout'}
        </button>
        <button type="button" onClick={() => load()}>
          Refresh seats
        </button>
      </div>
    </main>
  )
}
