'use client'

import { use, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { BookingStatus, PaymentAttempt } from '@/lib/booking/types'
import type { PaymentSimulation } from '@/lib/payments/gateway'

interface BookingDetail {
  id: string
  status: BookingStatus
  cancellation_reason: string | null
  student_name: string
  parent_name: string
  class_title: string
  class_subject: string
  class_starts_at: string
  price_cents: number
  payment_attempts: PaymentAttempt[]
}

const STATUS_COPY: Record<BookingStatus, { tone: string; label: string; detail: string }> = {
  pending_payment: {
    tone: 'warn',
    label: 'Awaiting payment',
    detail: 'No seat is reserved yet. The seat is won when the payment starts.',
  },
  processing_payment: {
    tone: 'warn',
    label: 'Payment in progress',
    detail: 'The seat is reserved while the card is being charged.',
  },
  confirmed: {
    tone: 'ok',
    label: 'Confirmed',
    detail: 'Paid and on the class roster.',
  },
  payment_failed: {
    tone: 'bad',
    label: 'Payment failed',
    detail: 'The seat was released. You can try paying again.',
  },
  cancelled: {
    tone: 'bad',
    label: 'Cancelled',
    detail: 'This booking is closed.',
  },
  expired: {
    tone: 'bad',
    label: 'Expired',
    detail: 'This checkout was abandoned and has been cleaned up.',
  },
}

export default function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ simulate?: string }>
}) {
  const { id } = use(params)
  const { simulate: simulateParam } = use(searchParams)
  const simulate = (simulateParam ?? 'success') as PaymentSimulation

  const [booking, setBooking] = useState<BookingDetail>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [outcome, setOutcome] = useState<string>()

  const load = useCallback(async () => {
    const response = await fetch(`/api/bookings/${id}`)
    if (!response.ok) {
      setError('Booking not found.')
      return
    }
    const body = await response.json()
    setBooking(body.booking)
  }, [id])

  useEffect(() => {
    load().catch(() => setError('Could not load this booking.'))
  }, [load])

  async function pay() {
    setBusy(true)
    setError(undefined)
    setOutcome(undefined)

    try {
      const response = await fetch(`/api/bookings/${id}/payment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ simulate }),
      })
      const body = await response.json()

      if (!response.ok) {
        setError(`${body.error.code}: ${body.error.message}`)
      } else {
        setOutcome(body.outcome)
      }
    } catch {
      setError('Network error.')
    } finally {
      setBusy(false)
      await load()
    }
  }

  if (error && !booking) {
    return (
      <main>
        <div className="error">{error}</div>
        <Link href="/">Back to classes</Link>
      </main>
    )
  }

  if (!booking) {
    return (
      <main>
        <p className="empty">Loading&hellip;</p>
      </main>
    )
  }

  const status = STATUS_COPY[booking.status]
  const payable = booking.status === 'pending_payment' || booking.status === 'payment_failed'

  return (
    <main>
      <h1>Booking status</h1>
      <p className="subtitle">
        <code>{booking.id}</code>
      </p>

      {error && <div className="error">{error}</div>}

      {outcome === 'class_full' && (
        <div className="error">
          <strong>Someone else took the last seat.</strong> Your card was not charged &mdash; the
          seat is reserved before the payment is attempted, so there is nothing to refund.
        </div>
      )}

      {outcome === 'seat_expired' && (
        <div className="error">
          <strong>This checkout took too long and the seat was released.</strong> If the payment
          below shows as succeeded, it will be refunded &mdash; the booking was never confirmed, so
          the seat went back to the class.
        </div>
      )}

      <div className="card">
        <div className="row">
          <div>
            <strong>{booking.class_title}</strong>
            <div className="muted">
              {booking.class_subject} &middot;{' '}
              {new Date(booking.class_starts_at).toLocaleString()}
            </div>
          </div>
          <span className={`badge ${status.tone}`}>{status.label}</span>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {status.detail}
          {booking.cancellation_reason && (
            <>
              {' '}
              Reason: <code>{booking.cancellation_reason}</code>
            </>
          )}
        </p>
      </div>

      <div className="card">
        <table>
          <tbody>
            <tr>
              <th>Child</th>
              <td>{booking.student_name}</td>
            </tr>
            <tr>
              <th>Parent</th>
              <td>{booking.parent_name}</td>
            </tr>
            <tr>
              <th>Amount</th>
              <td>S${(booking.price_cents / 100).toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Payment attempts</h2>
      <div className="card">
        {booking.payment_attempts.length === 0 ? (
          <p className="empty" style={{ margin: 0 }}>
            None. The card has not been touched.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Result</th>
                  <th>Reference</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {booking.payment_attempts.map((attempt) => (
                  <tr key={attempt.id}>
                    <td>{new Date(attempt.created_at).toLocaleTimeString()}</td>
                    <td>
                      <span className={`badge ${attempt.status === 'succeeded' ? 'ok' : 'bad'}`}>
                        {attempt.status}
                      </span>
                    </td>
                    <td>
                      <code>{attempt.provider_ref}</code>
                    </td>
                    <td className="muted">{attempt.failure_reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="actions">
        {payable && (
          <button type="button" className="primary" disabled={busy} onClick={pay}>
            {busy
              ? 'Contacting the gateway…'
              : booking.status === 'payment_failed'
                ? `Retry payment (${simulate})`
                : `Pay S$${(booking.price_cents / 100).toFixed(2)} (${simulate})`}
          </button>
        )}
        <button type="button" onClick={() => load()}>
          Refresh
        </button>
        <Link href="/">
          <button type="button">Book another</button>
        </Link>
        <Link href="/admin">
          <button type="button">See the roster</button>
        </Link>
      </div>
    </main>
  )
}
