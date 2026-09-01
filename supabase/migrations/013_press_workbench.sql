-- press: the workbench — many drafts, a pool that outlives its issues, orders,
-- and settings that are editable without a deploy.
-- See docs/plans/2026-08-31-003-feat-press-workbench-plan.md.
--
-- Applies on top of 009 (schema), 010 (position), 011 (skipped) and 012 (built_order).
--
-- ORDER OF OPERATIONS. This migration removes press_bootstrap_issue, which the
-- worker deployed on Fly calls on every poll, and drops the one-open-issue
-- index that the same worker's assignToOpenIssue relies on. Deploy the worker
-- in this branch FIRST, then apply this. Applying it against the old worker
-- leaves it erroring on every tick, and — worse, while it still runs — sweeping
-- pool items into whichever issue happens to be open.

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
-- exists — that is the whole point of locking, and press_place_order sets
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

-- press_bootstrap_issue is not dropped, it is made to refuse.
--
-- Dropping it would break the deployed worker with "function does not exist",
-- which is an obscure way to learn that you forgot to redeploy. Leaving it
-- working would be worse: assignToOpenIssue would go on sweeping every
-- laid_out item into whichever issue is open, which is precisely the behaviour
-- the pool exists to stop, and it would do it silently.
--
-- So it raises. A worker running the old code fails on its first call — at
-- boot, before it can touch anything — and says why. A crashed worker moves
-- no articles.
CREATE OR REPLACE FUNCTION press_bootstrap_issue()
RETURNS press_issues
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'press_bootstrap_issue was removed by migration 013: this worker is running pre-workbench code and would sweep the pool into an open issue. Deploy worker/ from the workbench branch.';
END;
$$;

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
-- 010 added UNIQUE (issue_id, position) as a partial index, on the assumption
-- that the editor "writes every position in one statement". It does not:
-- setIssueOrder loops one UPDATE per row, so moving an article from position 2
-- to position 0 collides with whatever already holds 0. A non-deferrable index
-- rejects that at the first row. Nothing has ever hit it because nothing has
-- ever run against a real database.
--
-- A deferrable constraint checks at COMMIT instead, so a reorder is free to
-- pass through a state where two rows briefly share a slot, and is still
-- rejected if it ends there. Reordering must therefore run in a transaction
-- with SET CONSTRAINTS press_items_issue_position_uniq DEFERRED — which is why
-- setIssueOrder is an RPC (press_set_issue_order) rather than a loop in TS:
-- PostgREST gives no way to hold a transaction open across requests.
--
-- The constraint cannot carry 010's WHERE clause — table constraints have no
-- partial form — but it does not need one. UNIQUE treats NULLs as distinct, so
-- every pool row (NULL, NULL) still coexists with every other.
-- Constraint first, then the index. Order matters and is not obvious: after
-- this migration has run once, the name belongs to a CONSTRAINT that owns its
-- index, and DROP INDEX on it errors ("cannot drop index ... because
-- constraint ... requires it") rather than being skipped. Dropping the
-- constraint takes its index with it; the DROP INDEX that follows is only for
-- 010's plain index, on a database seeing this for the first time.
ALTER TABLE press_items DROP CONSTRAINT IF EXISTS press_items_issue_position_uniq;
DROP INDEX IF EXISTS press_items_issue_position_uniq;
ALTER TABLE press_items
  ADD CONSTRAINT press_items_issue_position_uniq
  UNIQUE (issue_id, position) DEFERRABLE INITIALLY IMMEDIATE;

-- Write a whole running order in one transaction, positions deferred so the
-- permutation is judged only on where it lands. Items not named are removed
-- from the issue and returned to the pool, which is what the editor means by
-- dragging one out.
CREATE OR REPLACE FUNCTION press_set_issue_order(p_issue_id UUID, p_item_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_state TEXT;
  v_count INTEGER;
BEGIN
  SELECT state INTO v_state FROM press_issues WHERE id = p_issue_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'press_set_issue_order: no such issue %', p_issue_id;
  END IF;
  IF v_state <> 'open' THEN
    RAISE EXCEPTION 'press_set_issue_order: issue % is not a draft', p_issue_id;
  END IF;

  SET CONSTRAINTS press_items_issue_position_uniq DEFERRED;

  -- Out first: anything this issue holds that the new order does not name.
  UPDATE press_items
     SET issue_id = NULL, position = NULL, state = 'laid_out', updated_at = now()
   WHERE issue_id = p_issue_id
     AND state = 'in_issue'
     AND NOT (id = ANY (p_item_ids));

  -- Then in, at its index. Refuses anything that is not free or already here:
  -- an article claimed by another draft cannot be in two issues at once.
  UPDATE press_items i
     SET issue_id = p_issue_id,
         -- WITH ORDINALITY counts from 1; position is 0-based (010, and the
         -- comment on the column says so). Off by one here would not reorder
         -- anything wrongly — the sort is relative — but it would quietly make
         -- the column disagree with its own documentation, and with the
         -- positions press-import wrote.
         position = o.ord - 1,
         state = 'in_issue',
         updated_at = now()
    FROM unnest(p_item_ids) WITH ORDINALITY AS o(item_id, ord)
   WHERE i.id = o.item_id
     AND (i.issue_id IS NULL OR i.issue_id = p_issue_id)
     AND i.state IN ('laid_out', 'in_issue');
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count <> array_length(p_item_ids, 1) THEN
    RAISE EXCEPTION 'press_set_issue_order: % of % articles could not be placed — one belongs to another issue, or is not waiting to be printed',
      array_length(p_item_ids, 1) - v_count, array_length(p_item_ids, 1);
  END IF;

  RETURN v_count;
END;
$$;

-- ── The pool ─────────────────────────────────────────────────────────────────
-- 'dropped': deleted from the pool on purpose. Distinct from 'failed', which
-- is a broken extraction that might be worth retrying, and from 'skipped',
-- which is a reference page the pipeline set aside and you can un-skip.
ALTER TABLE press_items DROP CONSTRAINT IF EXISTS press_items_state_check;
ALTER TABLE press_items ADD CONSTRAINT press_items_state_check
  CHECK (state IN ('queued','extracted','laid_out','in_issue','printed','failed','skipped','dropped'));

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
  -- FOR UPDATE, because the guard below and the UPDATE that acts on it must
  -- see the same row. Without it, Auto-fill placing this article into an issue
  -- between the two would leave a `dropped` row still carrying issue_id — and
  -- itemsForIssue selects on issue_id alone, so a deleted article would stay in
  -- the running order and get printed.
  SELECT * INTO v_item FROM press_items WHERE id = p_item_id FOR UPDATE;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'press_drop_item: no such item %', p_item_id;
  END IF;
  IF v_item.state = 'dropped' THEN
    RAISE EXCEPTION 'press_drop_item: % is already deleted', p_item_id;
  END IF;
  IF v_item.issue_id IS NOT NULL OR v_item.state = 'in_issue' THEN
    RAISE EXCEPTION 'press_drop_item: % belongs to an issue; remove it from the issue first', p_item_id;
  END IF;
  IF v_item.state = 'printed' THEN
    RAISE EXCEPTION 'press_drop_item: % has been printed', p_item_id;
  END IF;

  -- The WHERE repeats the guard. Belt to the FOR UPDATE's braces: if this
  -- ever runs without the lock, it declines rather than corrupting an issue.
  UPDATE press_items
     SET state = 'dropped', position = NULL, updated_at = now()
   WHERE id = p_item_id
     AND issue_id IS NULL
     AND state <> 'in_issue'
  RETURNING * INTO v_item;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'press_drop_item: % was placed in an issue while being deleted', p_item_id;
  END IF;

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

-- The row exists from here on, so the form is an UPDATE and never a race
-- between two INSERTs. Every column it leaves NULL falls back to the
-- environment, so this changes nothing until the form is filled in.
INSERT INTO press_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

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

-- The same guarantee press_claim_order gave, one level down: a retried call
-- carrying the same key finds its row instead of buying a second copy.
CREATE UNIQUE INDEX IF NOT EXISTS press_orders_idempotency_key
  ON press_orders (idempotency_key);
CREATE INDEX IF NOT EXISTS press_orders_issue_idx ON press_orders (issue_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS press_orders_placed_idx ON press_orders (placed_at DESC);
-- Status refresh reads exactly the unfinished ones.
CREATE INDEX IF NOT EXISTS press_orders_open_idx
  ON press_orders (updated_at)
  WHERE shipped_at IS NULL;

ALTER TABLE press_orders ENABLE ROW LEVEL SECURITY;

-- Claim the right to create exactly one Lulu job, and record the order it is
-- for. Replaces press_claim_order, which could only ever express one order per
-- issue because it kept the claim in press_issues.lulu_job_id.
--
-- Two callers, one function:
--   a locked issue        → this is the print run. The issue advances to
--                           'approved' in the same statement that claims it,
--                           so "an unlocked issue cannot be printed" stays a
--                           Postgres guarantee rather than a UI one.
--   an ordered/shipped one → this is another copy of something already
--                           printed. The issue's own state machine is done and
--                           is left alone; only a row is added.
--
-- Idempotent on the key: a retry after a timeout finds the first attempt's row
-- and returns it, rather than buying a second copy.
CREATE OR REPLACE FUNCTION press_place_order(
  p_issue_id        UUID,
  p_idempotency_key TEXT,
  p_quantity        INTEGER,
  p_ship_to         JSONB,
  p_ordered_by      TEXT
)
RETURNS press_orders
LANGUAGE plpgsql
AS $$
DECLARE
  v_order press_orders;
  v_state TEXT;
BEGIN
  SELECT * INTO v_order FROM press_orders WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_order;
  END IF;

  SELECT state INTO v_state FROM press_issues WHERE id = p_issue_id FOR UPDATE;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'press_place_order: no such issue %', p_issue_id;
  END IF;

  -- Read the key AGAIN, now that the issue is locked. The first lookup is
  -- unlocked, so two callers carrying the same key — a client timeout and its
  -- retry, or two taps on the approval link — can both miss it and both get
  -- here. Whichever loses the lock would otherwise find the issue already
  -- 'approved' and be refused as "not locked", which reports a *successful*
  -- order as a configuration error and invites someone to place it by hand.
  SELECT * INTO v_order FROM press_orders WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_order;
  END IF;

  -- 'approved' with no job id is a claim whose Lulu call never came back. It
  -- is retryable — createPrintJob carries the same idempotency key, so Lulu
  -- collapses it if the job did in fact land. Without this the issue is
  -- wedged: reopen refuses (lulu_job_id is set), and ordering refuses (not
  -- closed), so nothing can move it in either direction ever again.
  IF v_state = 'approved' AND EXISTS (
    SELECT 1 FROM press_issues WHERE id = p_issue_id AND lulu_job_id = 'pending'
  ) THEN
    v_state := 'closed';
  END IF;

  IF v_state IN ('closed', 'rejected') THEN
    UPDATE press_issues
       SET state = 'approved',
           approved_at = COALESCE(approved_at, now()),
           lulu_idempotency_key = p_idempotency_key,
           lulu_job_id = 'pending',
           updated_at = now()
     WHERE id = p_issue_id;
  ELSIF v_state NOT IN ('ordered', 'shipped') THEN
    RAISE EXCEPTION 'press_place_order: issue % is %, and only a locked issue can be printed', p_issue_id, v_state;
  END IF;

  INSERT INTO press_orders (issue_id, idempotency_key, quantity, ship_to, ordered_by)
  VALUES (p_issue_id, p_idempotency_key, COALESCE(p_quantity, 1), p_ship_to, p_ordered_by)
  RETURNING * INTO v_order;

  INSERT INTO press_events (issue_id, kind, detail)
  VALUES (p_issue_id, 'order_claimed',
          jsonb_build_object('order_id', v_order.id, 'idempotency_key', p_idempotency_key,
                             'quantity', v_order.quantity, 'reorder', v_state IN ('ordered','shipped')));

  RETURN v_order;
END;
$$;

DROP FUNCTION IF EXISTS press_claim_order(UUID, TEXT);

-- Nothing here is reachable with the anon key.
REVOKE ALL ON FUNCTION press_new_issue() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_close_issue(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_reopen_issue(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_skip_issue(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_set_issue_order(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_drop_item(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_place_order(UUID, TEXT, INTEGER, JSONB, TEXT) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
