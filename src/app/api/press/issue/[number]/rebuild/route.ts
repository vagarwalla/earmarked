/**
 * press — rebuild an issue's PDFs from its draft.
 *
 * Separate from the mutation route because it behaves nothing like it: a
 * hundred-page issue is minutes of Chromium, so this streams NDJSON progress
 * lines as it goes rather than making the browser wait on one JSON body.
 *
 *   {"progress":"Rendering the cover"}
 *   {"done":{"name":"…","pageCount":104,"preflight":[]}}
 *   {"error":"…"}
 *
 * Editing marks nothing dirty by hand — the UI derives that by comparing the
 * draft with `meta.json`, which this rewrites on success.
 */

import { NextResponse } from 'next/server'
import { listIssues, pressUiEnabled, readState } from '@/lib/press/local'
import { reviewSource } from '@/lib/press/review'
import { loadSettings } from '@/lib/press/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** Rendering is the whole point of this route; it must not be cut short. */
export const maxDuration = 3600

export async function POST(
  _request: Request,
  context: { params: Promise<{ number: string }> },
) {
  if (!pressUiEnabled()) return new NextResponse('not found', { status: 404 })

  const { number: raw } = await context.params
  if (!/^\d+$/.test(raw)) return NextResponse.json({ error: 'bad issue' }, { status: 400 })
  const number = Number.parseInt(raw, 10)

  // Rendering an issue is minutes of headless Chromium. It does not fit a
  // serverless function, and the 93MB of browser it would drag along puts the
  // whole route over the deploy size limit — so deployed, this is honestly a
  // 501 and the rebuild happens where press-run runs.
  if (reviewSource() === 'supabase') {
    return NextResponse.json(
      { error: 'Rebuilding needs a machine with a browser. Run press-run locally, then re-import.' },
      { status: 501 },
    )
  }

  // Imported here rather than at module scope so the Chromium-adjacent
  // packages are only ever loaded on a machine that can use them.
  const { BuildBusyError, BuildError, buildIssue, withBuildLock } = await import('@/lib/press/build')

  const settings = loadSettings()
  const state = await readState()
  const issue = (await listIssues(state, settings.pageThreshold)).find((i) => i.number === number)
  if (!issue) return NextResponse.json({ error: 'no such issue' }, { status: 404 })
  if (issue.printed) {
    return NextResponse.json({ error: 'That issue has been printed.' }, { status: 409 })
  }

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
        const result = await withBuildLock(() =>
          buildIssue({
            number,
            items: issue.contents.map((e) => ({
              id: e.itemId,
              title: e.title,
              url: e.url ?? '',
              pageCount: e.pageCount,
            })),
            apiKey: settings.anthropicApiKey,
            // A rebuild re-renders this issue; it does not re-title it. Only
            // once it has been built though — `listIssues` synthesises
            // "Issue N" for one that has not, and pinning that would stop a
            // first build from ever being named.
            name: issue.built ? issue.name : undefined,
            onProgress: (message) => send({ progress: message }),
          }),
        )
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
}
