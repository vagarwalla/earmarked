-- press: saved reading → printed magazine pipeline.
-- See docs/plans/2026-08-27-001-feat-press-magazine-pipeline-plan.md (U1).
--
-- Unlike the rest of this schema, press tables carry personal data (reading
-- history, a shipping address flows near them) and this repo is public, so
-- they get RLS with NO policies: the anon key cannot touch them at all.
-- Both runtimes (Vercel routes, Fly worker) reach them with the service-role
-- key via src/lib/press/db.ts.

-- ── Issues ───────────────────────────────────────────────────────────────────
-- State machine (U1):
--   open → closed → approved → ordered → shipped
--   closed → skipped   (V declines; items reassign to the open issue)
--   closed → rejected  (Lulu refuses the files post-approval)
CREATE TABLE IF NOT EXISTS press_issues (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number                INTEGER NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'open'
                          CHECK (state IN ('open','closed','approved','ordered','shipped','skipped','rejected')),
  name                  TEXT,
  page_total            INTEGER NOT NULL DEFAULT 0,
  interior_path         TEXT,
  cover_path            TEXT,
  quote_cents           INTEGER,
  quote_currency        TEXT,
  lulu_job_id           TEXT,
  lulu_idempotency_key  TEXT,
  lulu_status           TEXT,
  tracking_url          TEXT,
  archive_collection_id TEXT,
  rejection_reason      TEXT,
  opened_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at             TIMESTAMPTZ,
  approved_at           TIMESTAMPTZ,
  ordered_at            TIMESTAMPTZ,
  shipped_at            TIMESTAMPTZ,
  approval_sent_at      TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS press_issues_number_key ON press_issues (number);
-- Exactly one issue is open at any time (assumption: close-and-open is atomic).
CREATE UNIQUE INDEX IF NOT EXISTS press_issues_single_open ON press_issues ((state)) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS press_issues_state_idx ON press_issues (state);

ALTER TABLE press_issues ENABLE ROW LEVEL SECURITY;

-- ── Items ────────────────────────────────────────────────────────────────────
-- State machine (U1): queued → extracted → laid_out → in_issue → printed
--                     any → failed (reason recorded)
CREATE TABLE IF NOT EXISTS press_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url             TEXT,
  -- Normalized URL used for dedupe; NULL for items with no URL (newsletters, PDFs).
  url_key         TEXT,
  source          TEXT NOT NULL CHECK (source IN ('raindrop','email_link','newsletter','pdf','x')),
  raindrop_id     TEXT,
  state           TEXT NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','extracted','laid_out','in_issue','printed','failed')),
  issue_id        UUID REFERENCES press_issues(id) ON DELETE SET NULL,
  title           TEXT,
  byline          TEXT,
  source_name     TEXT,
  published_at    TIMESTAMPTZ,
  -- Storage paths in the `press` bucket.
  content_path    TEXT,   -- normalized article JSON (U3)
  fragment_path   TEXT,   -- measurement PDF (U4) or normalized upload (U2, PDFs)
  page_count      INTEGER,
  failure_reason  TEXT,
  raw_email_path  TEXT,   -- raw MIME kept from day one (U2)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedupe a re-dropped link. Partial so many URL-less items can coexist.
CREATE UNIQUE INDEX IF NOT EXISTS press_items_url_key_uniq ON press_items (url_key) WHERE url_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS press_items_state_idx ON press_items (state);
CREATE INDEX IF NOT EXISTS press_items_issue_idx ON press_items (issue_id);
CREATE INDEX IF NOT EXISTS press_items_raindrop_idx ON press_items (raindrop_id) WHERE raindrop_id IS NOT NULL;

ALTER TABLE press_items ENABLE ROW LEVEL SECURITY;

-- ── Events (append-only audit) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS press_events (
  id          BIGSERIAL PRIMARY KEY,
  issue_id    UUID REFERENCES press_issues(id) ON DELETE SET NULL,
  item_id     UUID REFERENCES press_items(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS press_events_issue_idx ON press_events (issue_id, created_at DESC);
ALTER TABLE press_events ENABLE ROW LEVEL SECURITY;

-- ── Action tokens (U6) ───────────────────────────────────────────────────────
-- Approve / skip / drop links in the approval email. Only the SHA-256 of the
-- token is stored, so a leaked table row cannot be replayed as a link.
CREATE TABLE IF NOT EXISTS press_action_tokens (
  token_hash  TEXT PRIMARY KEY,
  issue_id    UUID NOT NULL REFERENCES press_issues(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN ('approve','skip','drop','preview')),
  item_id     UUID REFERENCES press_items(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS press_action_tokens_issue_idx ON press_action_tokens (issue_id);
ALTER TABLE press_action_tokens ENABLE ROW LEVEL SECURITY;

-- ── Poll cursors (U2) ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS press_cursors (
  source      TEXT PRIMARY KEY,
  cursor      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE press_cursors ENABLE ROW LEVEL SECURITY;

-- ── Atomic operations ────────────────────────────────────────────────────────
-- These exist as SQL functions because the invariants they protect ("exactly
-- one open issue", "never order twice") cannot be upheld by a client doing
-- read-then-write across two round trips.

-- Ensure exactly one open issue exists; return it. Idempotent.
CREATE OR REPLACE FUNCTION press_bootstrap_issue()
RETURNS press_issues
LANGUAGE plpgsql
AS $$
DECLARE
  v_issue press_issues;
BEGIN
  SELECT * INTO v_issue FROM press_issues WHERE state = 'open' LIMIT 1;
  IF FOUND THEN
    RETURN v_issue;
  END IF;

  INSERT INTO press_issues (number, state)
  VALUES ((SELECT COALESCE(MAX(number), 0) + 1 FROM press_issues), 'open')
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_issue;

  -- Lost a race with a concurrent bootstrap: read the winner's row.
  IF v_issue IS NULL THEN
    SELECT * INTO v_issue FROM press_issues WHERE state = 'open' LIMIT 1;
  END IF;

  RETURN v_issue;
END;
$$;

-- Close the open issue and open its successor in one transaction, so the
-- pipeline is never left with zero open issues for arriving items to land in.
CREATE OR REPLACE FUNCTION press_close_issue(p_issue_id UUID, p_page_total INTEGER)
RETURNS press_issues
LANGUAGE plpgsql
AS $$
DECLARE
  v_closed press_issues;
  v_next   press_issues;
BEGIN
  UPDATE press_issues
     SET state = 'closed', closed_at = now(), page_total = p_page_total, updated_at = now()
   WHERE id = p_issue_id AND state = 'open'
  RETURNING * INTO v_closed;

  IF v_closed IS NULL THEN
    RAISE EXCEPTION 'press_close_issue: issue % is not open', p_issue_id;
  END IF;

  INSERT INTO press_issues (number, state)
  VALUES ((SELECT COALESCE(MAX(number), 0) + 1 FROM press_issues), 'open')
  RETURNING * INTO v_next;

  INSERT INTO press_events (issue_id, kind, detail)
  VALUES (p_issue_id, 'issue_closed', jsonb_build_object('page_total', p_page_total, 'next_issue', v_next.id));

  RETURN v_closed;
END;
$$;

-- V declines an issue: its items go back into the currently open issue.
CREATE OR REPLACE FUNCTION press_skip_issue(p_issue_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_open_id UUID;
  v_moved   INTEGER;
BEGIN
  UPDATE press_issues
     SET state = 'skipped', updated_at = now()
   WHERE id = p_issue_id AND state IN ('closed', 'rejected');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'press_skip_issue: issue % is not closed', p_issue_id;
  END IF;

  SELECT id INTO v_open_id FROM press_issues WHERE state = 'open' LIMIT 1;

  UPDATE press_items
     SET issue_id = v_open_id, state = 'laid_out', updated_at = now()
   WHERE issue_id = p_issue_id AND state = 'in_issue';
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  INSERT INTO press_events (issue_id, kind, detail)
  VALUES (p_issue_id, 'issue_skipped', jsonb_build_object('items_reassigned', v_moved, 'to_issue', v_open_id));

  RETURN v_moved;
END;
$$;

-- Approve + claim the right to create exactly one Lulu job. The check and the
-- set happen in one statement, so a timeout-then-retry cannot double-order:
-- the retry sees claimed = false and the key the first caller persisted.
CREATE OR REPLACE FUNCTION press_claim_order(p_issue_id UUID, p_idempotency_key TEXT)
RETURNS TABLE (claimed BOOLEAN, idempotency_key TEXT, lulu_job_id TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_issue press_issues;
BEGIN
  UPDATE press_issues
     SET state = 'approved',
         approved_at = COALESCE(approved_at, now()),
         lulu_idempotency_key = p_idempotency_key,
         lulu_job_id = 'pending',
         updated_at = now()
   WHERE id = p_issue_id
     AND state IN ('closed', 'rejected')
     AND lulu_job_id IS NULL
  RETURNING * INTO v_issue;

  IF v_issue IS NOT NULL THEN
    INSERT INTO press_events (issue_id, kind, detail)
    VALUES (p_issue_id, 'order_claimed', jsonb_build_object('idempotency_key', p_idempotency_key));
    RETURN QUERY SELECT TRUE, v_issue.lulu_idempotency_key, v_issue.lulu_job_id;
    RETURN;
  END IF;

  SELECT * INTO v_issue FROM press_issues WHERE id = p_issue_id;
  RETURN QUERY SELECT FALSE, v_issue.lulu_idempotency_key, v_issue.lulu_job_id;
END;
$$;

-- Single-use action tokens: mark used and hand back the row in one statement.
CREATE OR REPLACE FUNCTION press_consume_token(p_token_hash TEXT)
RETURNS press_action_tokens
LANGUAGE plpgsql
AS $$
DECLARE
  v_token press_action_tokens;
BEGIN
  UPDATE press_action_tokens
     SET used_at = now()
   WHERE token_hash = p_token_hash
     AND used_at IS NULL
     AND expires_at > now()
  RETURNING * INTO v_token;

  RETURN v_token;
END;
$$;

-- Nothing here is reachable with the anon key.
REVOKE ALL ON FUNCTION press_bootstrap_issue() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_close_issue(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_skip_issue(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_claim_order(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_consume_token(TEXT) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
