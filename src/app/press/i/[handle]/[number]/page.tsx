/**
 * press — one shared issue.
 *
 * The contents, and the PDF. Read-only in the strong sense: the reader is
 * handed `sharedIssue`, which is a projection with no ids in it, so there is
 * nothing on this page that an editing route would accept even if somebody
 * took it apart.
 *
 * The running order shown is `built_order` — what the PDF was actually
 * rendered from. If that ever disagrees with the items' own positions, the
 * PDF is what the reader is holding and the list should match it.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { pressUiEnabled } from '@/lib/press/local'
import { sharedIssue } from '@/lib/press/shared'
import { PrintSpec } from '@/app/press/PrintSpec'
import { LULU_PACKAGE_ID } from '@/lib/press/types'
import { ThemeToggle } from '@/components/ThemeToggle'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string; number: string }>
}) {
  const { handle, number } = await params
  const issue = await sharedIssue(handle, Number.parseInt(number, 10)).catch(() => null)
  if (!issue) return { title: 'press' }
  const who = issue.owner.display_name ?? `@${issue.owner.handle}`
  return { title: `${issue.name} — ${who}`, description: `Issue ${issue.number}, ${issue.pageCount} pages.` }
}

export default async function SharedIssuePage({
  params,
}: {
  params: Promise<{ handle: string; number: string }>
}) {
  if (!pressUiEnabled()) notFound()

  const { handle, number: raw } = await params
  if (!/^\d+$/.test(raw)) notFound()

  const issue = await sharedIssue(handle, Number.parseInt(raw, 10))
  if (!issue) notFound()

  const who = issue.owner.display_name ?? `@${issue.owner.handle}`

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <div>
          <Link
            href={`/press/by/${issue.owner.handle}`}
            className="text-muted-foreground text-sm underline underline-offset-2"
          >
            {who}
          </Link>
          <h1 className="font-serif mt-1 text-3xl">{issue.name}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Issue {issue.number} · {issue.pageCount} pages
          </p>
        </div>
        <ThemeToggle />
      </header>

      <h2 className="text-muted-foreground mb-2 text-xs tracking-wide uppercase">Contents</h2>
      <ol className="mb-8 divide-y border-y">
        {issue.articles.map((a, i) => (
          <li key={i} className="flex items-baseline justify-between gap-4 py-3">
            <span>
              <span className="font-serif">{a.title}</span>
              {(a.byline || a.sourceName) && (
                <span className="text-muted-foreground block text-xs">
                  {[a.byline, a.sourceName].filter(Boolean).join(' · ')}
                </span>
              )}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{a.pages} pp</span>
          </li>
        ))}
      </ol>

      {issue.interiorUrl ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <a
              href={issue.interiorUrl}
              className="bg-foreground text-background rounded-md px-4 py-2.5 text-center text-sm font-medium"
            >
              Read the issue
            </a>
            {issue.coverUrl && (
              <a href={issue.coverUrl} className="rounded-md border px-4 py-2.5 text-center text-sm">
                Cover
              </a>
            )}
          </div>
          {/* What it is if you want one of your own. The links expire in an
              hour, which is the one thing worth saying out loud — a page that
              silently stops working is worse than one that said it would. */}
          <p className="text-muted-foreground mt-3 text-xs">
            Print-ready PDFs. The links expire in an hour; reload the page for fresh ones.
          </p>
          <div className="mt-6">
            <PrintSpec packageId={LULU_PACKAGE_ID} pageCount={issue.pageCount} />
          </div>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">The files for this issue are not available.</p>
      )}

      <p className="text-muted-foreground mt-10 text-xs">
        Make your own with <Link href="/press" className="underline underline-offset-2">press</Link>.
      </p>
    </main>
  )
}
