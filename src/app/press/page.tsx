/**
 * press — the review page.
 *
 * Everything the local pipeline has produced, in one place: composed issues
 * with a live PDF preview and download links, the contents of each with links
 * back to the originals so a bad extraction can be spotted, and what is still
 * waiting in `hw` for the next issue.
 *
 * The open issue is editable — reorder, drop, pull one forward, rebuild — via
 * `IssueEditor`; a printed issue is fixed and reads as a plain list. Both come
 * from the same draft in `.press/state.json`.
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
import { loadSettings } from '@/lib/press/settings'
import { ThemeToggle } from '@/components/ThemeToggle'
import { IssueEditor } from './IssueEditor'
import { IssuePreview } from './IssuePreview'

export const dynamic = 'force-dynamic'

function hostOf(url: string | null): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export default async function PressPage() {
  // The page lists what V has been reading; it has no place on a public deploy.
  if (!pressUiEnabled()) notFound()

  const threshold = loadSettings().pageThreshold
  const state = await readState()
  const issues = await listIssues(state, threshold)

  const waiting = pendingItems(state).map((i) => ({
    id: i.id,
    title: i.title,
    url: i.url,
    pageCount: i.pageCount ?? 0,
  }))
  const skipped = itemsInState(state, 'skipped')
  const failed = itemsInState(state, 'failed')

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-10 flex items-baseline justify-between">
        <div>
          <h1 className="font-serif text-3xl">Saved reading, laid out for print.</h1>
        </div>
        <ThemeToggle />
      </header>

      {issues.length === 0 && (
        <p className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
          Nothing here yet. Run{' '}
          <code className="bg-muted rounded px-1.5 py-0.5">npx tsx scripts/press-run.ts</code>
        </p>
      )}

      {issues.map((issue) => (
        <section key={issue.number} className="mb-14">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="font-serif text-2xl">{issue.name}</h2>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Issue {issue.number}
                {issue.built
                  ? ` · ${issue.pageCount} pages · ${formatBytes(issue.interiorBytes)}`
                  : ' · not built yet'}
                {issue.printed && ' · printed'}
                {issue.builtAt && ` · built ${issue.builtAt.slice(0, 10)}`}
              </p>
            </div>
            <div className="flex gap-2 text-sm">
              {/* Open in the browser's viewer rather than saving to disk: the
                  route serves these inline unless `?download` asks otherwise,
                  and looking at a proof should not litter ~/Downloads. */}
              {issue.hasInterior && (
                <a
                  className="hover:bg-accent rounded-md border px-3 py-1.5"
                  href={`/api/press/file/${issue.number}/interior.pdf`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Interior PDF
                </a>
              )}
              {issue.hasCover && (
                <a
                  className="hover:bg-accent rounded-md border px-3 py-1.5"
                  href={`/api/press/file/${issue.number}/cover.pdf`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Cover PDF
                </a>
              )}
            </div>
          </div>

          {issue.hasInterior && (
            <IssuePreview
              issueNumber={issue.number}
              version={issue.builtAt}
              hasCover={issue.hasCover}
            />
          )}

          {issue.printed ? (
            // Its raindrops have been archived and the copy bought; what it
            // contains is now a matter of record rather than a decision.
            <ol className="mt-6 divide-y rounded-lg border">
              {issue.contents.map((entry) => (
                <li key={entry.itemId} className="flex items-baseline gap-4 px-4 py-3">
                  <span className="text-muted-foreground w-10 shrink-0 text-right text-xs tabular-nums">
                    {entry.startPage === null ? '' : `p.${entry.startPage}`}
                  </span>
                  <span className="min-w-0 flex-1">
                    {entry.url ? (
                      <a
                        href={entry.url}
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
                      {[entry.byline, entry.sourceName].filter(Boolean).join(' · ') ||
                        hostOf(entry.url)}
                    </span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {entry.pageCount}pp
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <IssueEditor
              issueNumber={issue.number}
              contents={issue.contents}
              waiting={waiting}
              dirty={issue.dirty}
              built={issue.built}
              threshold={threshold}
            />
          )}
        </section>
      ))}

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
