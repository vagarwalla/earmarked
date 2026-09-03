/**
 * press — which of the two machines this is.
 *
 * On V's machine press is a filesystem application: `.press/state.json`, a
 * directory per article, and PDFs on disk, and a render happens inside the
 * request that asked for it. Deployed there is no disk and no browser: state
 * is Postgres, files are in the `press` bucket, and a render is a job the Fly
 * worker claims.
 *
 * This is the one question that decides between them, and it needs no
 * configuration: if `.press/state.json` is there, that is the live copy and it
 * wins; if it is not — a Vercel function, say — Supabase is the only thing
 * there is. `PRESS_SOURCE` forces either, which is mostly useful for checking
 * the deployed path from a laptop that also has a `.press`.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

export type ReviewSource = 'local' | 'supabase'

export function reviewSource(): ReviewSource {
  const forced = process.env.PRESS_SOURCE
  if (forced === 'supabase' || forced === 'local') return forced
  // The disk is the live copy wherever it exists; a deployed function has none.
  return existsSync(path.join(process.cwd(), '.press', 'state.json')) ? 'local' : 'supabase'
}

// loadReview lived here: one shape for the review page, assembled from the
// disk or from Postgres depending on which existed. The workbench replaced the
// page it fed and it has had no callers since — and it was the last thing in
// this file that read the database, which is why it went now rather than
// growing an owner it had nobody to get one from.
//
// `reviewSource()` above is the part that is still load-bearing: it is how
// /rebuild and /lock decide between rendering here and asking the worker.
