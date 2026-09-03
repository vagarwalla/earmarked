/**
 * press — what every workbench route does before it does anything else.
 *
 * The page and its routes are off in production unless PRESS_UI_ENABLED=1,
 * because they list what V has been reading. The password in `src/middleware.ts`
 * is the other half; this is the half that survives a matcher someone forgot
 * to update.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { currentOwnerId } from '@/lib/press/accounts'
import { pressDb } from '@/lib/press/db'
import { pressUiEnabled } from '@/lib/press/local'
import { WorkbenchError } from '@/lib/press/workbench'

export { pressUiEnabled }

/** 404 rather than 403: a disabled page should not admit it exists. */
export const NOT_FOUND = () => new NextResponse('not found', { status: 404 })

/**
 * Turn a thrown error into the response the panel should show.
 *
 * A `WorkbenchError` is a refusal with a sentence worth printing — an article
 * claimed by another draft, a delete of something an issue is holding. Anything
 * else is a bug and says so, because a 500 dressed as a polite message is how a
 * broken pipeline looks fine for a week.
 */
export function asResponse(err: unknown): NextResponse {
  if (err instanceof WorkbenchError) {
    return NextResponse.json({ error: err.message }, { status: 409 })
  }
  const message = (err as Error).message ?? 'Something went wrong.'
  // A missing table is the one infrastructure error worth naming precisely:
  // it means migration 013 has not been applied, and every workbench route
  // will fail the same way until it is.
  if (/relation "press_(settings|orders)" does not exist|Could not find the function/i.test(message)) {
    return NextResponse.json(
      { error: 'The workbench schema is not applied yet — run `npm run db:apply -- 013_press_workbench.sql`.' },
      { status: 503 },
    )
  }
  return NextResponse.json({ error: message }, { status: 500 })
}

/** Parse an issue number out of a route parameter. */
export function issueNumber(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null
}

/**
 * The database, as whoever is looking at the workbench.
 *
 * Every editing route starts with this. `pressDb` has no unscoped form and
 * nothing here has a default client, so a route that skips this line does not
 * compile — which is the whole of how one person's press stays out of
 * another's (see src/lib/press/db.ts and migration 018).
 *
 * The exceptions are the routes that have no session to scope by: the approval
 * links and the inbound email webhook, which authenticate with a signed token
 * and a shared secret respectively and reach for `pressDbAsService()` by name.
 */
export async function ownerDb(): Promise<SupabaseClient> {
  return pressDb(await currentOwnerId())
}
