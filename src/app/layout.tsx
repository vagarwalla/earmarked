import type { Metadata } from 'next'
import { Inter, Fraunces } from 'next/font/google'
import { Toaster } from '@/components/ui/sonner'
import { Providers } from '@/components/providers'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' })
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-serif', axes: ['opsz'] })

export const metadata: Metadata = {
  title: 'Earmarked — Find cheap used books',
  description: 'Build a list of books, find cheap used copies, minimize cost by grouping sellers.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} ${fraunces.variable} antialiased`}>
        <Providers>
          {children}
          <Toaster />
        </Providers>
      </body>
    </html>
  )
}
