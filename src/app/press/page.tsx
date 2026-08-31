/**
 * press — the review page.
 *
 * Everything the local pipeline has produced, in one place: composed issues
 * with a live PDF preview and download links, the contents of each with links
 * back to the originals so a bad extraction can be spotted, and what is still
 * waiting in `hw` for the next issue.
 *
 * A server component reading `.press/` directly — there is no database in the
 * local setup, and the files are the state.
 */

import { notFound } from 'next/navigation'
import {
  formatBytes,
  itemsInState,
  listIssues,
  pendingItems,
  pressUiEnabled,
  readState,
} from '@/lib/press/local'
import { tocMeta } from '@/lib/press/types'
import { ThemeToggle } from '@/components/ThemeToggle'
import { IssuePreview } from './IssuePreview'

export const dynamic = 'force-dynamic'

const PAGE_THRESHOLD = Number.parseInt(process.env.PRESS_PAGE_THRESHOLD ?? '100', 10) || 100

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export default async function PressPage() {
  // The page lists what V has been reading; it has no place on a public deploy.
  if (!pressUiEnabled()) notFound()

  const state = await readState()
  const issues = await listIssues(state)

  // Articles stay `laid_out` until an issue is actually ordered, so anything
  // already composed into one would otherwise be counted twice — once in the
  // issue and again as still waiting.
  const composed = new Set(issues.flatMap((i) => i.articles.map((a) => a.id)))
  const pending = pendingItems(state).filter((i) => !composed.has(i.id))
  const skipped = itemsInState(state, 'skipped')
  const failed = itemsInState(state, 'failed')

  const pendingPages = pending.reduce((n, i) => n + (i.pageCount ?? 0), 0)

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-10 flex items-baseline justify-between">
        <div>
          <h1 className="font-serif text-3xl">press</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Saved reading, laid out for print.
          </p>
        </div>
        <ThemeToggle />
      </header>

      {issues.length === 0 && (
        <p className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
          Nothing composed yet. Run{' '}
          <code className="bg-muted rounded px-1.5 py-0.5">npx tsx scripts/press-run.ts --compose</code>
        </p>
      )}

      {issues.map((issue) => (
        <section key={issue.number} className="mb-14">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="font-serif text-2xl">{issue.name}</h2>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Issue {issue.number} · {issue.pageCount} pages · {formatBytes(issue.interiorBytes)}
                {issue.printed && ' · printed'}
                {issue.builtAt && ` · built ${issue.builtAt.slice(0, 10)}`}
              </p>
            </div>
            <div className="flex gap-2 text-sm">
              {issue.hasInterior && (
                <a
                  className="rounded-md border px-3 py-1.5 hover:bg-accent"
                  href={`/api/press/file/${issue.number}/interior.pdf?download`}
                >
                  Interior PDF
                </a>
              )}
              {issue.hasCover && (
                <a
                  className="rounded-md border px-3 py-1.5 hover:bg-accent"
                  href={`/api/press/file/${issue.number}/cover.pdf?download`}
                >
                  Cover PDF
                </a>
              )}
            </div>
          </div>

          {issue.hasInterior && <IssuePreview issueNumber={issue.number} />}

          <ol className="mt-6 divide-y rounded-lg border">
            {issue.toc.map((entry) => {
              const source = issue.articles.find((a) => a.id === entry.itemId)
              return (
                <li key={entry.itemId} className="flex items-baseline gap-4 px-4 py-3">
                  <span className="text-muted-foreground w-10 shrink-0 text-right text-xs tabular-nums">
                    p.{entry.startPage}
                  </span>
                  <span className="min-w-0 flex-1">
                    {source ? (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-serif hover:underline"
                      >
                        {entry.title}
                      </a>
                    ) : (
                      <span className="font-serif">{entry.title}</span>
                    )}
                    <span className="text-muted-foreground block text-xs">
                      {tocMeta(entry) || (source ? hostOf(source.url) : '')}
                    </span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {entry.pageCount}pp
                  </span>
                </li>
              )
            })}
          </ol>
        </section>
      ))}

      <section className="mb-12">
        <h2 className="font-serif text-xl">
          Waiting for the next issue{' '}
          <span className="text-muted-foreground text-sm font-sans">
            {pending.length} articles · {pendingPages} of {PAGE_THRESHOLD} pages
          </span>
        </h2>
        <div className="bg-muted mt-3 h-1.5 w-full overflow-hidden rounded-full">
          <div
            className="bg-foreground h-full rounded-full"
            style={{ width: `${Math.min(100, (pendingPages / PAGE_THRESHOLD) * 100)}%` }}
          />
        </div>
        <ol className="mt-4 divide-y rounded-lg border">
          {pending.map((item) => (
            <li key={item.id} className="flex items-baseline gap-4 px-4 py-3">
              <span className="min-w-0 flex-1">
                <a href={item.url} target="_blank" rel="noreferrer" className="font-serif hover:underline">
                  {item.title ?? item.url}
                </a>
                <span className="text-muted-foreground block text-xs">{hostOf(item.url)}</span>
              </span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {item.pageCount ?? '?'}pp
              </span>
            </li>
          ))}
          {pending.length === 0 && (
            <li className="text-muted-foreground px-4 py-6 text-center text-sm">
              Nothing waiting. Save something to hw.
            </li>
          )}
        </ol>
      </section>

      {(skipped.length > 0 || failed.length > 0) && (
        <section className="text-muted-foreground mb-12 text-sm">
          <h2 className="text-foreground font-serif text-xl">Not included</h2>
          <ul className="mt-3 space-y-2">
            {skipped.map((item) => (
              <li key={item.id}>
                <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline">
                  {item.title ?? item.url}
                </a>{' '}
                — skipped as a reference page
              </li>
            ))}
            {failed.map((item) => (
              <li key={item.id}>
                <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline">
                  {item.title ?? hostOf(item.url)}
                </a>{' '}
                — {item.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
