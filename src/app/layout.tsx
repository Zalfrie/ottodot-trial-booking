import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ottodot - Trial Booking',
  description: 'Book a trial class',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Book a trial</Link>
          <Link href="/admin">Rosters</Link>
        </nav>
        {children}
      </body>
    </html>
  )
}
