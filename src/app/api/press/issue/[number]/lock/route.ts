/**
 * press — lock a draft, and unlock one that has not been ordered.
 *
 *   POST   { action: 'lock' }    compose the final PDFs, then freeze
 *   POST   { action: 'unlock' }  back to a draft, while no Lulu job exists
 *
 * Lock is one button and not two because a lock that leaves stale PDFs behind
 * is a trap: the whole point of the state is that what you approve is what gets
 * printed. So this composes first and only calls `press_close_issue` if the
 * render succeeded.
 *
 * That has a consequence worth stating plainly. Composing is minutes of
 * headless Chromium, so — exactly like `/rebuild`, and for exactly the same
 * reason — locking only works where there is a browser. Deployed, this answers
 * 501 and says where to do it instead. See plan §9.
 *
 * Streams NDJSON progress, like /rebuild, because a button that appears to
 * hang for four minutes is a button people press twice.
 */

import { NextResponse } from 'next/server'
import { reviewSource } from '@/lib/press/review'
import { itemsForIssue } from '@/lib/press/db'
import { issueByNumber, lockIssue, unlockIssue } from '@/lib/press/workbench'
import { loadEffectiveSettings } from '@/lib/press/settings-db'
import { NOT_FOUND, asResponse, issueNumber, pressUiEnabled } from '../../../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** No maxDuration, for the reason spelled out in ../rebuild/route.ts. */

export async function POST(request: Request, context: { params: Promise<{ number: string }> }) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const { number: raw } = await context.params
  const number = issueNumber(raw)
  if (number === null) return NextResponse.json({ error: 'bad issue' }, { status: 400 })

  const body = (await request.json().catch(() => null)) as { action?: string } | null

  try {
    const issue = await issueByNumber(number)
    if (!issue) return NextResponse.json({ error: 'no such issue' }, { status: 404 })

    if (body?.action === 'unlock') {
      await unlockIssue(issue.id)
      return NextResponse.json({ ok: true, state: 'open' })
    }
    if (body?.action !== 'lock') {
      return NextResponse.json({ error: 'bad request' }, { status: 400 })
    }

    const items = await itemsForIssue(issue.id)
    if (items.length === 0) {
      return NextResponse.json({ error: 'An empty issue cannot be locked.' }, { status: 409 })
    }

    // Rendering does not fit a serverless function, and the 93MB of browser it
    // would drag in puts the route over the deploy size limit. Honest 501.
    if (reviewSource() === 'supabase') {
      return NextResponse.json(
        {
          error:
            'Locking composes the final PDFs, which needs a machine with a browser. ' +
            'Run press-sync locally and lock from there.',
        },
        { status: 501 },
      )
    }

    const settings = await loadEffectiveSettings()
    const { BuildBusyError, BuildError, buildIssue, withBuildLock } = await import('@/lib/press/build')

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: object) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
          } catch {
            // The reader has gone; the build finishes anyway rather than
            // leaving a torn issue behind.
          }
        }

        try {
          const result = await withBuildLock(() =>
            buildIssue({
              number,
              items: items.map((i) => ({
                id: i.id,
                title: i.title ?? i.url ?? i.id,
                url: i.url ?? '',
                pageCount: i.page_count ?? 0,
              })),
              apiKey: settings.anthropicApiKey,
              // The name is frozen at lock (plan question 3): a draft may be
              // renamed freely, by Haiku or by hand, and stops moving here.
              name: issue.name ?? undefined,
              onProgress: (message) => send({ progress: message }),
            }),
          )

          // Only now: a lock whose render failed would freeze contents against
          // PDFs that do not match them, which is the trap this avoids.
          await lockIssue(issue.id, result.pageCount)
          send({
            done: {
              name: result.name,
              pageCount: result.pageCount,
              preflight: result.preflight,
              state: 'closed',
            },
          })
        } catch (err) {
          const expected = err instanceof BuildError || err instanceof BuildBusyError
          send({ error: expected ? (err as Error).message : `Lock failed: ${(err as Error).message}` })
        } finally {
          controller.close()
        }
      },
    })

    return new NextResponse(stream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      },
    })
  } catch (err) {
    return asResponse(err)
  }
}
