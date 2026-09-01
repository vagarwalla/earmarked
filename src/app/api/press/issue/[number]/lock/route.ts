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
import { localItems, mirrorOrder, publishBuild } from '@/lib/press/handoff'
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

    // Before anything is rendered: `press_close_issue` refuses a non-draft, but
    // it is the *last* thing this route calls, so without this the render runs,
    // the PDFs are published over a locked issue's, and only then does the lock
    // fail. Two tabs on /press is all it takes — the second still shows the
    // issue as a draft, because nothing polls.
    if (issue.state !== 'open') {
      return NextResponse.json(
        { error: `Issue ${number} is already ${issue.state === 'closed' ? 'locked' : issue.state}.` },
        { status: 409 },
      )
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

    // The renderer reads `.press/items/<id>/`, where the id is the raindrop id
    // and not the UUID Postgres uses. `localItems` is that translation, and it
    // says up front which articles this machine has no text for rather than
    // failing on the first one, four minutes in.
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
          // The disk follows the website, as in `press-sync`'s pull, so that
          // what is frozen here and what a later sync sees are one issue.
          await mirrorOrder(number, build.map((i) => i.id))

          const result = await withBuildLock(() =>
            buildIssue({
              number,
              items: build,
              apiKey: settings.anthropicApiKey,
              // The name is frozen at lock (plan question 3): a draft may be
              // renamed freely, by Haiku or by hand, and stops moving here.
              name: issue.name ?? undefined,
              onProgress: (message) => send({ progress: message }),
            }),
          )

          // A Storage failure is named as itself: the PDFs are on disk either
          // way, and "Lock failed" about a compose that succeeded sends you
          // looking at the renderer instead of at Storage.
          try {
            await publishBuild(issue, {
              name: result.name,
              pageCount: result.pageCount,
              itemIds: items.map((i) => i.id),
            })
          } catch (err) {
            throw new BuildError(
              `Composed here, but the website was not updated: ${(err as Error).message}`,
            )
          }

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
