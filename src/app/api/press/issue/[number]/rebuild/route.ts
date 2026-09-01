/**
 * press — rebuild an issue's PDFs from what the website says it holds.
 *
 * Separate from the mutation route because it behaves nothing like it: a
 * hundred-page issue is minutes of Chromium, so this streams NDJSON progress
 * lines as it goes rather than making the browser wait on one JSON body.
 *
 *   {"progress":"Rendering the cover"}
 *   {"done":{"name":"…","pageCount":104,"preflight":[]}}
 *   {"error":"…"}
 *
 * The contents come from Postgres, which is the list the workbench is showing
 * and the only place anyone edits it. This used to read `.press/state.json`
 * instead and rebuild whatever the disk happened to hold — the order from
 * before the edit, or the articles of an issue the website says is empty — so
 * the button appeared to work and changed nothing. `handoff.ts` makes the
 * crossing in both directions: the running order down onto the disk before the
 * render, the PDFs and page count back up after it.
 */

import { NextResponse } from 'next/server'
import { itemsForIssue } from '@/lib/press/db'
import { localItems, mirrorOrder, publishBuild } from '@/lib/press/handoff'
import { issueByNumber } from '@/lib/press/workbench'
import { reviewSource } from '@/lib/press/review'
import { loadEffectiveSettings } from '@/lib/press/settings-db'
import { NOT_FOUND, asResponse, issueNumber, pressUiEnabled } from '../../../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/**
 * No maxDuration. A full render takes minutes, but the only place it ever runs
 * is a local dev server, which does not enforce one — and asking for 3600 on
 * Vercel is not a slow function, it is a failed *deploy*: Hobby caps
 * maxDuration at 300, and the builder rejects the whole deployment rather than
 * the one route. Deployed, this route answers 501 in a few milliseconds.
 */

export async function POST(
  _request: Request,
  context: { params: Promise<{ number: string }> },
) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const { number: raw } = await context.params
  const number = issueNumber(raw)
  if (number === null) return NextResponse.json({ error: 'bad issue' }, { status: 400 })

  // Rendering an issue is minutes of headless Chromium. It does not fit a
  // serverless function, and the 93MB of browser it would drag along puts the
  // whole route over the deploy size limit — so deployed, this is honestly a
  // 501, before the two queries below and in the few milliseconds the comment
  // above promises.
  if (reviewSource() === 'supabase') {
    return NextResponse.json(
      { error: 'Rebuilding needs a machine with a browser. Run press-run locally, then re-import.' },
      { status: 501 },
    )
  }

  try {
    const issue = await issueByNumber(number)
    if (!issue) return NextResponse.json({ error: 'no such issue' }, { status: 404 })
    // Only a draft. A locked issue's PDFs are what its contents were frozen
    // against and what an order hands Lulu; re-rendering over them from a
    // second tab that still thinks the issue is open would replace the exact
    // objects a signed URL is pointing at.
    if (issue.state !== 'open') {
      return NextResponse.json(
        { error: `Issue ${number} is ${issue.state === 'closed' ? 'locked' : issue.state}; unlock it first.` },
        { status: 409 },
      )
    }

    const items = await itemsForIssue(issue.id)
    if (items.length === 0) {
      return NextResponse.json({ error: 'An empty issue has nothing to render.' }, { status: 409 })
    }

    // An article that was never extracted on this machine cannot be rendered,
    // and finding that out one article into a four-minute build helps nobody.
    const { build, missing } = localItems(items)
    if (missing.length) {
      return NextResponse.json(
        {
          error:
            `No extracted text on this machine for ${missing.map((t) => `“${t}”`).join(', ')}. ` +
            'Run npm run press:sync and try again.',
        },
        { status: 409 },
      )
    }

    // Imported here rather than at module scope so the Chromium-adjacent
    // packages are only ever loaded on a machine that can use them.
    const { BuildBusyError, BuildError, buildIssue, withBuildLock } = await import('@/lib/press/build')
    const settings = await loadEffectiveSettings()

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: object) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
          } catch {
            // The reader has gone. The build finishes anyway — its output is
            // files on disk, and abandoning it halfway would leave a torn issue.
          }
        }

        try {
          // Before the render, not after: `press-sync` compares the disk's
          // draft with what was built to decide whether to build again, and a
          // disk left on the old order would rebuild this from underneath.
          await mirrorOrder(number, build.map((i) => i.id))

          const result = await withBuildLock(() =>
            buildIssue({
              number,
              items: build,
              apiKey: settings.anthropicApiKey,
              // A rebuild re-renders this issue; it does not re-title it. Only
              // once it has one, though — an unnamed draft gets its name from
              // the build, and pinning the placeholder would stop that.
              name: issue.name ?? undefined,
              onProgress: (message) => send({ progress: message }),
            }),
          )

          // The workbench reads Postgres, so until this lands the page count is
          // the old one and the issue still reads "edited since the last build".
          // Its own failure, and named as one: the PDFs are on disk either
          // way, and "Build failed" about a build that succeeded sends you
          // looking at the renderer instead of at Storage.
          try {
            await publishBuild(issue, {
              name: result.name,
              pageCount: result.pageCount,
              itemIds: items.map((i) => i.id),
            })
          } catch (err) {
            throw new BuildError(
              `Rebuilt here, but the website was not updated: ${(err as Error).message}`,
            )
          }

          send({
            done: {
              name: result.name,
              pageCount: result.pageCount,
              preflight: result.preflight,
            },
          })
        } catch (err) {
          const expected = err instanceof BuildError || err instanceof BuildBusyError
          send({ error: expected ? (err as Error).message : `Build failed: ${(err as Error).message}` })
        } finally {
          controller.close()
        }
      },
    })

    return new NextResponse(stream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        // Progress that arrives all at once at the end is not progress.
        'x-accel-buffering': 'no',
      },
    })
  } catch (err) {
    return asResponse(err)
  }
}
