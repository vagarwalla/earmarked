/**
 * press — somebody's shelf.
 *
 * The page V sends friends. Every issue she has marked shared, newest first,
 * and nothing else: no pool, no drafts, no buttons. Outside the middleware's
 * matcher, because the whole point is that it opens without a session.
 *
 * There is no "private" state to get wrong here. The reader only ever gets
 * `sharedShelf`, which filters on `visibility = 'shared'` in the query rather
 * than in the page — a page cannot forget to hide something it was never given.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { pressUiEnabled } from '@/lib/press/local'
import { sharedShelf } from '@/lib/press/shared'
import { ThemeToggle } from '@/components/ThemeToggle'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params
  const shelf = await sharedShelf(handle).catch(() => null)
  const who = shelf?.displayName ?? `@${handle}`
  return {
    title: `${who} — press`,
    description: `Issues ${who} has printed.`,
  }
}

function madeOn(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export default async function ShelfPage({ params }: { params: Promise<{ handle: string }> }) {
  if (!pressUiEnabled()) notFound()

  const { handle } = await params
  const shelf = await sharedShelf(handle)
  // A handle nobody has is a 404, not an empty shelf — the second would say
  // "this person shares nothing" about somebody who does not exist.
  if (!shelf) notFound()

  const who = shelf.displayName ?? `@${shelf.handle}`

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl">{who}</h1>
          <p className="text-muted-foreground mt-1 text-sm">Saved reading, laid out for print.</p>
        </div>
        <ThemeToggle />
      </header>

      {shelf.issues.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing shared yet.</p>
      ) : (
        <ul className="divide-y border-y">
          {shelf.issues.map((issue) => (
            <li key={issue.number}>
              <Link
                href={`/press/i/${shelf.handle}/${issue.number}`}
                className="hover:bg-muted/50 flex items-baseline justify-between gap-4 px-1 py-4 transition-colors"
              >
                <span>
                  <span className="text-muted-foreground mr-2 text-xs tabular-nums">
                    {String(issue.number).padStart(2, '0')}
                  </span>
                  <span className="font-serif text-lg">{issue.name}</span>
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {issue.pageCount} pp · {madeOn(issue.madeAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="text-muted-foreground mt-10 text-xs">
        Made with <Link href="/press" className="underline underline-offset-2">press</Link>.
      </p>
    </main>
  )
}
