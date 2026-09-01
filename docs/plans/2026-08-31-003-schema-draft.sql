-- press: the workbench — many drafts, a pool that outlives its issues, orders,
-- and settings that are editable without a deploy.
-- See docs/plans/2026-08-31-003-feat-press-workbench-plan.md.
--
-- Applies on top of 009 (schema) and 010 (running order). Ships with the code
-- change that repoints /press at this database; the two are one branch, since
-- this migration removes a function the current worker still calls.

-- ── Many drafts at once ──────────────────────────────────────────────────────
-- 009 enforced exactly one open issue because items were swept into whatever
-- issue was open the moment they finished extracting, so a second open issue
-- would have made "which one" ambiguous. Items now land in the pool instead
-- (issue_id IS NULL) and are placed by hand, so the ambiguity is gone and
-- several drafts can be built in parallel.
DROP INDEX IF EXISTS press_issues_single_open;

-- The state names carry over unchanged; only what they mean to a reader moves:
--   open     → "Draft"    editable, any number of them
--   closed   → "Locked"   contents fixed, built, printable
--   approved/ordered/shipped/rejected → unchanged
-- press_claim_order already refuses anything not in ('closed','rejected'),
-- so "an unlocked issue cannot be printed" needs no new enforcement.

-- Nothing needs a successor issue to land in any more, so closing one stops
-- creating the next. Opening an issue is now something you ask for.
CREATE OR REPLACE FUNCTION press_close_issue(p_issue_id UUID, p_page_total INTEGER)
RETURNS press_issues
LANGUAGE plpgsql
AS $$
DECLARE
  v_closed press_issues;
BEGIN
  UPDATE press_issues
     SET state = 'closed', closed_at = now(), page_total = p_page_total, updated_at = now()
   WHERE id = p_issue_id AND state = 'open'
  RETURNING * INTO v_closed;

  IF v_closed IS NULL THEN
    RAISE EXCEPTION 'press_close_issue: issue % is not a draft', p_issue_id;
  END IF;

  INSERT INTO press_events (issue_id, kind, detail)
  VALUES (p_issue_id, 'issue_locked', jsonb_build_object('page_total', p_page_total));

  RETURN v_closed;
END;
$$;

-- Unlock, while it is still only a draft in disguise. Refused once a Lulu job
-- exists — that is the whole point of locking, and press_claim_order sets
-- lulu_job_id in the same statement that approves.
CREATE OR REPLACE FUNCTION press_reopen_issue(p_issue_id UUID)
RETURNS press_issues
LANGUAGE plpgsql
AS $$
DECLARE
  v_issue press_issues;
BEGIN
  UPDATE press_issues
     SET state = 'open', closed_at = NULL, updated_at = now()
   WHERE id = p_issue_id
     AND state IN ('closed', 'rejected')
     AND lulu_job_id IS NULL
  RETURNING * INTO v_issue;

  IF v_issue IS NULL THEN
    RAISE EXCEPTION 'press_reopen_issue: issue % is not an unordered locked issue', p_issue_id;
  END IF;

  INSERT INTO press_events (issue_id, kind, detail) VALUES (p_issue_id, 'issue_unlocked', '{}'::jsonb);
  RETURN v_issue;
END;
$$;

-- Allocate the next issue number and open a draft. Replaces
-- press_bootstrap_issue, whose "return the open issue if there is one" is
-- ambiguous the moment more than one can be open.
CREATE OR REPLACE FUNCTION press_new_issue()
RETURNS press_issues
LANGUAGE plpgsql
AS $$
DECLARE
  v_issue press_issues;
BEGIN
  INSERT INTO press_issues (number, state)
  VALUES ((SELECT COALESCE(MAX(number), 0) + 1 FROM press_issues), 'open')
  RETURNING * INTO v_issue;

  INSERT INTO press_events (issue_id, kind, detail)
  VALUES (v_issue.id, 'issue_opened', jsonb_build_object('number', v_issue.number));

  RETURN v_issue;
END;
$$;

DROP FUNCTION IF EXISTS press_bootstrap_issue();

-- press_skip_issue reassigned a declined issue's items to "the open issue".
-- There may now be none, or several. They go to the pool, which is where an
-- unplaced article belongs.
CREATE OR REPLACE FUNCTION press_skip_issue(p_issue_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_moved INTEGER;
BEGIN
  UPDATE press_issues
     SET state = 'skipped', updated_at = now()
   WHERE id = p_issue_id AND state IN ('closed', 'rejected');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'press_skip_issue: issue % is not locked', p_issue_id;
  END IF;

  UPDATE press_items
     SET issue_id = NULL, position = NULL, state = 'laid_out', updated_at = now()
   WHERE issue_id = p_issue_id AND state = 'in_issue';
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  INSERT INTO press_events (issue_id, kind, detail)
  VALUES (p_issue_id, 'issue_skipped', jsonb_build_object('items_returned_to_pool', v_moved));

  RETURN v_moved;
END;
$$;

-- ── The running order, made safe to permute ──────────────────────────────────
-- 010 added UNIQUE (issue_id, position) as a plain index, on the assumption
-- that the editor "writes every position in one statement". It does not:
-- setIssueOrder loops one UPDATE per row, so moving an article from position 2
-- to position 0 collides with whatever already holds 0. A non-deferrable index
-- rejects that at the first row. Nothing has ever hit it because nothing has
-- ever run against a real database.
--
-- A deferrable constraint checks at COMMIT instead, so a reorder is free to
-- pass through a state where two rows briefly share a slot, and is still
-- rejected if it ends there. Reordering must therefore run in a transaction
-- with SET CONSTRAINTS press_items_issue_position_uniq DEFERRED.
DROP INDEX IF EXISTS press_items_issue_position_uniq;
ALTER TABLE press_items
  ADD CONSTRAINT press_items_issue_position_uniq
  UNIQUE (issue_id, position) DEFERRABLE INITIALLY IMMEDIATE;

-- ── The pool ─────────────────────────────────────────────────────────────────
-- 'dropped': deleted from the pool on purpose. Distinct from 'failed', which
-- is a broken extraction that might be worth retrying, and from 'skipped'
-- items, which are reference pages the pipeline set aside.
ALTER TABLE press_items DROP CONSTRAINT IF EXISTS press_items_state_check;
ALTER TABLE press_items ADD CONSTRAINT press_items_state_check
  CHECK (state IN ('queued','extracted','laid_out','in_issue','printed','failed','dropped'));

-- The pool query — everything waiting and unplaced — is the most frequent read
-- in the workbench, and it is exactly the rows this index holds.
CREATE INDEX IF NOT EXISTS press_items_pool_idx
  ON press_items (created_at DESC)
  WHERE issue_id IS NULL AND state = 'laid_out';

-- Permanent delete, refused for anything an issue is holding. Removing an
-- article from an issue returns it to the pool; deleting it is a second,
-- separate decision made there. Issues are arrangements of the pool, so
-- nothing is ever destroyed from inside one.
CREATE OR REPLACE FUNCTION press_drop_item(p_item_id UUID, p_archive_collection_id TEXT)
RETURNS press_items
LANGUAGE plpgsql
AS $$
DECLARE
  v_item press_items;
BEGIN
  SELECT * INTO v_item FROM press_items WHERE id = p_item_id;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'press_drop_item: no such item %', p_item_id;
  END IF;
  IF v_item.issue_id IS NOT NULL OR v_item.state = 'in_issue' THEN
    RAISE EXCEPTION 'press_drop_item: % belongs to an issue; remove it from the issue first', p_item_id;
  END IF;
  IF v_item.state = 'printed' THEN
    RAISE EXCEPTION 'press_drop_item: % has been printed', p_item_id;
  END IF;

  UPDATE press_items
     SET state = 'dropped', position = NULL, updated_at = now()
   WHERE id = p_item_id
  RETURNING * INTO v_item;

  -- url_key stays on the row, so its unique index makes the deletion stick:
  -- re-saving the same link to `hw` dedupes against this tombstone rather than
  -- resurrecting it. The raindrop itself is moved to a "Not printing"
  -- collection by the caller, which is where it can be recovered from.
  INSERT INTO press_events (item_id, kind, detail)
  VALUES (p_item_id, 'item_dropped',
          jsonb_build_object('archive_collection_id', p_archive_collection_id));

  RETURN v_item;
END;
$$;

-- ── Settings ─────────────────────────────────────────────────────────────────
-- One row, enforced by the primary key. Holds only what a form may hold: the
-- address, the contact address, and print policy. Every credential
-- (LULU_CLIENT_SECRET, RAINDROP_TOKEN, SUPABASE_SERVICE_ROLE_KEY) stays in the
-- environment — a settings form is not a place to keep a secret, and the card
-- itself never comes near this app at all: Lulu bills the account on file.
CREATE TABLE IF NOT EXISTS press_settings (
  id                BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),

  ship_name         TEXT,
  ship_street1      TEXT,
  ship_street2      TEXT,
  ship_city         TEXT,
  ship_state        TEXT,
  ship_postcode     TEXT,
  ship_country      TEXT NOT NULL DEFAULT 'US',
  ship_phone        TEXT,

  -- Where the approval email goes, and what the order dialog confirms against.
  contact_email     TEXT,

  page_threshold    INTEGER NOT NULL DEFAULT 100,
  copies            INTEGER NOT NULL DEFAULT 1 CHECK (copies > 0),
  lulu_package_id   TEXT,
  -- Production is opt-in here exactly as it is in the environment: a row that
  -- was never filled in cannot spend money.
  lulu_sandbox      BOOLEAN NOT NULL DEFAULT TRUE,

  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE press_settings ENABLE ROW LEVEL SECURITY;

-- ── Orders ───────────────────────────────────────────────────────────────────
-- An order is its own row rather than four columns on the issue. Today an
-- issue has at most one; the moment someone else can order a copy of issue 3,
-- orders are many-per-issue with different addresses and different payers, and
-- the panel that lists them should not need reshaping then.
CREATE TABLE IF NOT EXISTS press_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id          UUID NOT NULL REFERENCES press_issues(id) ON DELETE RESTRICT,

  lulu_job_id       TEXT,
  idempotency_key   TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  -- Lulu's per-line-item status, where a file-validation failure shows up.
  line_item_status  TEXT,
  message           TEXT,

  quantity          INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  cost_cents        INTEGER,
  currency          TEXT,
  tracking_urls     JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Snapshotted, not joined: where this copy actually went. Editing the
  -- address in settings must not rewrite the history of past orders.
  ship_to           JSONB,
  -- Yours today. Someone else's when copies can be ordered by other people.
  ordered_by        TEXT,

  placed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  shipped_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The same guarantee press_claim_order gives, one level down: a retried call
-- carrying the same key updates its row instead of buying a second copy.
CREATE UNIQUE INDEX IF NOT EXISTS press_orders_idempotency_key
  ON press_orders (idempotency_key);
CREATE INDEX IF NOT EXISTS press_orders_issue_idx ON press_orders (issue_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS press_orders_placed_idx ON press_orders (placed_at DESC);
-- Status refresh reads exactly the unfinished ones.
CREATE INDEX IF NOT EXISTS press_orders_open_idx
  ON press_orders (updated_at)
  WHERE shipped_at IS NULL;

ALTER TABLE press_orders ENABLE ROW LEVEL SECURITY;

-- Nothing here is reachable with the anon key.
REVOKE ALL ON FUNCTION press_new_issue() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_close_issue(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_reopen_issue(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_skip_issue(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_drop_item(UUID, TEXT) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
