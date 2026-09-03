import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  JobError,
  enqueueCompose,
  claimJob,
  finishJob,
  liveJobs,
  reportProgress,
} from '../jobs'
import { runComposeJob } from '../run-job'
import type { PressIssue, PressItem, PressJob } from '../types'

// ── A Supabase client just real enough for the queue ──────────────────────────
//
// Records what was asked of it. Every method returns the builder, and awaiting
// it yields whatever the test seeded — which is how the real client behaves for
// these calls and is all `jobs.ts` uses.

interface Seed {
  rows?: Record<string, unknown[]>
  insertError?: { code?: string; message: string }
  rpc?: Record<string, unknown>
}

function fakeDb(seed: Seed = {}) {
  const updates: { table: string; patch: Record<string, unknown> }[] = []
  const inserts: { table: string; row: Record<string, unknown> }[] = []
  const filters: { table: string; op: string; args: unknown[] }[] = []

  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {}
      const rows = () => seed.rows?.[table] ?? []
      b.select = () => b
      b.order = () => b
      b.limit = () => b
      b.eq = (...args: unknown[]) => {
        filters.push({ table, op: 'eq', args })
        return b
      }
      b.in = (...args: unknown[]) => {
        filters.push({ table, op: 'in', args })
        return b
      }
      b.update = (patch: Record<string, unknown>) => {
        updates.push({ table, patch })
        return b
      }
      b.insert = (row: Record<string, unknown>) => {
        inserts.push({ table, row })
        return b
      }
      b.single = async () =>
        seed.insertError ? { data: null, error: seed.insertError } : { data: rows()[0] ?? null, error: null }
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null })
      b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(r)
      return b
    },
    rpc: async (name: string) => ({ data: seed.rpc?.[name] ?? null, error: null }),
  }

  return { client: client as unknown as SupabaseClient, updates, inserts, filters }
}

function job(over: Partial<PressJob> = {}): PressJob {
  return {
    id: 'job-1',
    kind: 'compose',
    issue_id: 'iss1',
    intent: 'rebuild',
    state: 'queued',
    progress: null,
    error: null,
    result: null,
    created_at: '2026-09-03T00:00:00Z',
    started_at: null,
    finished_at: null,
    heartbeat_at: null,
    ...over,
  }
}

describe('enqueueCompose', () => {
  it('turns the one-live-job index into a sentence, not a stack trace', async () => {
    // 23505 is unique_violation, and the only unique index on press_jobs is
    // the one that stops two renders of the same issue. A second press of the
    // button is a question with an answer, not a 500.
    const db = fakeDb({ insertError: { code: '23505', message: 'duplicate key value' } })
    await expect(enqueueCompose('iss1', 'rebuild', db.client)).rejects.toBeInstanceOf(JobError)
  })

  it('lets a real database failure through as one', async () => {
    const db = fakeDb({ insertError: { code: '42P01', message: 'relation does not exist' } })
    const err = await enqueueCompose('iss1', 'rebuild', db.client).catch((e) => e)
    expect(err).not.toBeInstanceOf(JobError)
    expect((err as Error).message).toMatch(/relation does not exist/)
  })

  it('queues with the intent it was given', async () => {
    const db = fakeDb({ rows: { press_jobs: [job({ intent: 'lock' })] } })
    const queued = await enqueueCompose('iss1', 'lock', db.client)
    expect(db.inserts[0].row).toMatchObject({ kind: 'compose', issue_id: 'iss1', intent: 'lock' })
    expect(queued.intent).toBe('lock')
  })
})

describe('claimJob', () => {
  it('is null when there is nothing to do', async () => {
    expect(await claimJob(fakeDb().client)).toBeNull()
  })

  it('returns the row the function claimed', async () => {
    const db = fakeDb({ rpc: { press_claim_job: job({ state: 'running' }) } })
    expect((await claimJob(db.client))?.state).toBe('running')
  })
})

describe('reportProgress', () => {
  it('bumps the heartbeat with the line', async () => {
    // The two travel together on purpose: a heartbeat on its own timer would
    // keep a hung render looking alive, which is the one thing the reaper has
    // to be able to tell apart.
    const db = fakeDb()
    await reportProgress('job-1', 'Measuring 3 of 9', db.client)
    expect(db.updates[0].patch.progress).toBe('Measuring 3 of 9')
    expect(db.updates[0].patch.heartbeat_at).toBeTruthy()
  })
})

describe('liveJobs', () => {
  it('asks only for what has not finished', async () => {
    const db = fakeDb({ rows: { press_jobs: [job(), job({ id: 'job-2', state: 'running' })] } })
    expect(await liveJobs(db.client)).toHaveLength(2)
    expect(db.filters[0]).toMatchObject({ op: 'in', args: ['state', ['queued', 'running']] })
  })
})

describe('finishJob', () => {
  it('clears the progress line it is replacing', async () => {
    const db = fakeDb()
    await finishJob('job-1', { name: 'Winter Light', pageCount: 104, preflight: [] }, db.client)
    expect(db.updates[0].patch).toMatchObject({ state: 'done', progress: null })
  })
})

// ── Running one ──────────────────────────────────────────────────────────────

function issue(over: Partial<PressIssue> = {}): PressIssue {
  return {
    id: 'iss1',
    number: 3,
    state: 'open',
    name: 'Winter Light',
    page_total: 0,
    interior_path: null,
    cover_path: null,
    quote_cents: null,
    quote_currency: null,
    lulu_job_id: null,
    lulu_idempotency_key: null,
    lulu_status: null,
    tracking_url: null,
    archive_collection_id: null,
    built_order: null,
    rejection_reason: null,
    opened_at: '2026-09-01T00:00:00Z',
    closed_at: null,
    approved_at: null,
    ordered_at: null,
    shipped_at: null,
    approval_sent_at: null,
    updated_at: '2026-09-01T00:00:00Z',
    ...over,
  } as PressIssue
}

/** A db whose reads are seeded per table, for the runner's three lookups. */
function runnerDb(seedIssue: PressIssue | null, items: PressItem[]) {
  const db = fakeDb({
    rows: {
      press_issues: seedIssue ? [seedIssue] : [],
      press_items: items,
      press_jobs: [],
    },
  })
  return db
}

describe('runComposeJob', () => {
  it('refuses an issue that stopped being a draft while the job sat in the queue', async () => {
    // Locked from another tab between the press and the claim. Composing over
    // it would replace the exact objects a signed URL or a Lulu job points at.
    const db = runnerDb(issue({ state: 'closed' }), [])
    const result = await runComposeJob(job(), db.client)
    expect(result).toBeNull()
    const failed = db.updates.find((u) => u.patch.state === 'failed')
    expect(failed?.patch.error).toMatch(/locked/)
  })

  it('refuses an empty issue rather than rendering nothing', async () => {
    const db = runnerDb(issue(), [])
    expect(await runComposeJob(job(), db.client)).toBeNull()
    expect(db.updates.find((u) => u.patch.state === 'failed')?.patch.error).toMatch(/nothing to render/)
  })

  it('records a failure rather than throwing at the loop that called it', async () => {
    // The caller is a worker loop whose next act is to pick up the next job. A
    // job that ends without a terminal state is one the reaper cleans up half
    // an hour later, so every exit writes done or failed.
    const db = runnerDb(null, [])
    await expect(runComposeJob(job(), db.client)).resolves.toBeNull()
    expect(db.updates.some((u) => u.patch.state === 'failed')).toBe(true)
  })
})
