-- press: a queue for the work that needs a browser.
--
-- Composing an issue is minutes of headless Chromium. It does not fit a Vercel
-- function — /rebuild and /lock both answer 501 when deployed, and say so — so
-- the only machine that has ever been able to make a PDF is the one with
-- `.press/` on its disk. That is fine for one person with a laptop and is the
-- whole obstacle for anybody else.
--
-- The Fly worker already has Chromium, and `composeIssue()` already reads and
-- writes Storage with no disk dependency. What was missing was a way for a
-- button on the website to ask the worker to do something and to hear back.
-- This is that: one row per request, claimed atomically, progress written into
-- it as the render goes, and a terminal state either way.
--
-- Deliberately not a general job system. One kind, one worker, one at a time.
-- See docs/plans/2026-09-03-004-feat-press-sharing-plan.md §3.

CREATE TABLE IF NOT EXISTS press_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL DEFAULT 'compose' CHECK (kind IN ('compose')),
  issue_id     UUID NOT NULL REFERENCES press_issues(id) ON DELETE CASCADE,

  -- The two buttons that compose. `rebuild` re-renders a draft and leaves it
  -- open; `lock` renders and then freezes the contents, which is the same
  -- ordering /lock uses today — compose first, close only if it succeeded, so
  -- a locked issue is never frozen against PDFs that do not match it.
  intent       TEXT NOT NULL DEFAULT 'rebuild' CHECK (intent IN ('rebuild','lock')),

  state        TEXT NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued','running','done','failed')),
  -- The line the button is showing. Overwritten in place: nobody wants the
  -- history of a progress bar, and an append-only log of it would be the
  -- largest column in the schema.
  progress     TEXT,
  error        TEXT,
  -- What the caller would have got back from a streamed build: name, page
  -- count, preflight. Read once, when the poll sees `done`.
  result       JSONB,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  -- Bumped alongside every progress line. A machine that dies mid-render
  -- leaves a `running` row that would otherwise block the issue forever; this
  -- is how press_reap_jobs tells that apart from a slow render.
  heartbeat_at TIMESTAMPTZ
);

-- One live job per issue. This is the same guarantee `.press/build.lock` gives
-- locally, moved somewhere both runtimes can see it: two renders of the same
-- issue would fight over the same two objects in Storage, and the honest answer
-- to a second press of the button is that one is already running.
CREATE UNIQUE INDEX IF NOT EXISTS press_jobs_one_live
  ON press_jobs (issue_id) WHERE state IN ('queued','running');
CREATE INDEX IF NOT EXISTS press_jobs_queue_idx
  ON press_jobs (created_at) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS press_jobs_issue_idx ON press_jobs (issue_id, created_at DESC);

ALTER TABLE press_jobs ENABLE ROW LEVEL SECURITY;

-- Claim the oldest queued job, atomically.
--
-- SKIP LOCKED rather than a plain UPDATE ... LIMIT 1: there is one worker
-- today, but a second machine started by hand during a deploy must not be able
-- to pick up the job the first one is already claiming, and the failure mode
-- if it did — two Chromiums writing one interior.pdf — is a torn PDF rather
-- than an error.
CREATE OR REPLACE FUNCTION press_claim_job()
RETURNS press_jobs
LANGUAGE plpgsql
AS $$
DECLARE
  v_job press_jobs;
BEGIN
  UPDATE press_jobs
     SET state = 'running',
         started_at = now(),
         heartbeat_at = now(),
         progress = COALESCE(progress, 'Starting')
   WHERE id = (
     SELECT id FROM press_jobs
      WHERE state = 'queued'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;

-- Fail jobs whose worker stopped answering.
--
-- Without this a killed machine leaves a `running` row, the partial unique
-- index refuses every new job for that issue, and the button is dead until
-- someone opens the SQL editor. The interval must sit comfortably above the
-- 15-minute Vivliostyle timeout in vivliostyle.ts — a slow hundred-page render
-- is not a dead one.
CREATE OR REPLACE FUNCTION press_reap_jobs(p_stale INTERVAL DEFAULT INTERVAL '30 minutes')
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE press_jobs
     SET state = 'failed',
         error = 'The machine rendering this stopped answering. Try again.',
         finished_at = now()
   WHERE state = 'running'
     AND COALESCE(heartbeat_at, started_at, created_at) < now() - p_stale;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Nothing here is reachable with the anon key.
REVOKE ALL ON FUNCTION press_claim_job() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_reap_jobs(INTERVAL) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
