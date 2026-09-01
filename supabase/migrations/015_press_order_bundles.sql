-- press — one print job may carry several issues.
--
-- Lulu charges shipping per *job*, not per book: issue 1 and issue 2 ordered
-- separately are two parcels and two shipping charges, and the same two as
-- line items of one job are one of each. On live prices (2026-09-01, 7×10 full
-- colour standard, MAIL) that is $27.91 against $22.72 — the saving is entirely
-- the second parcel.
--
-- The shape this needs is the one press_orders already nearly has. An order
-- stays one row per issue, because everything downstream is per-issue: the
-- issue state machine, isPrintRun, the archive step, what the panel lists. A
-- bundle is those rows sharing a lulu_job_id, tied together by bundle_key.
--
-- Deliberately NOT a bundles table. A bundle has no life of its own — it is
-- created, sent to Lulu, and thereafter only ever read through its orders. A
-- table would add a join to every read to hold a column that is written once.

ALTER TABLE press_orders
  -- The job's idempotency key: identical across every row that went to Lulu in
  -- one job, NULL for the rows placed before bundling existed. Not a foreign
  -- key to anything — it is Lulu's handle on the job, and ours on the group.
  ADD COLUMN IF NOT EXISTS bundle_key TEXT,
  -- Which line of that job is this issue. Lulu reports file validation per
  -- line item, so "issue 4's interior was refused" has to find issue 4's row
  -- and not issue 3's. Zero for a single-issue job, which is what every
  -- existing row is.
  ADD COLUMN IF NOT EXISTS line_index INTEGER NOT NULL DEFAULT 0 CHECK (line_index >= 0);

-- Refreshing status reads a job once and fans the answer out over its rows.
CREATE INDEX IF NOT EXISTS press_orders_bundle_idx
  ON press_orders (bundle_key)
  WHERE bundle_key IS NOT NULL;

-- Two rows of one job cannot claim the same line.
CREATE UNIQUE INDEX IF NOT EXISTS press_orders_bundle_line_idx
  ON press_orders (bundle_key, line_index)
  WHERE bundle_key IS NOT NULL;

-- The 5-argument form has to go rather than gain a defaulted 6th: a default
-- would make every existing 5-argument call ambiguous between the two.
DROP FUNCTION IF EXISTS press_place_order(UUID, TEXT, INTEGER, JSONB, TEXT);

-- Claim the right to put one issue into one Lulu job, and record the order it
-- is for. Unchanged in every respect except that it now also records which job
-- and which line of it — call it once per issue in the bundle, each with its
-- own row key and the bundle's shared key.
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
-- and returns it, rather than buying a second copy. That is per row, so a
-- half-placed bundle re-driven with the same keys rejoins its own rows instead
-- of ordering the issues that did land a second time.
CREATE OR REPLACE FUNCTION press_place_order(
  p_issue_id        UUID,
  p_idempotency_key TEXT,
  p_quantity        INTEGER,
  p_ship_to         JSONB,
  p_ordered_by      TEXT,
  p_bundle_key      TEXT DEFAULT NULL,
  p_line_index      INTEGER DEFAULT 0
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

  INSERT INTO press_orders (issue_id, idempotency_key, quantity, ship_to, ordered_by, bundle_key, line_index)
  VALUES (p_issue_id, p_idempotency_key, COALESCE(p_quantity, 1), p_ship_to, p_ordered_by,
          p_bundle_key, COALESCE(p_line_index, 0))
  RETURNING * INTO v_order;

  INSERT INTO press_events (issue_id, kind, detail)
  VALUES (p_issue_id, 'order_claimed',
          jsonb_build_object('order_id', v_order.id, 'idempotency_key', p_idempotency_key,
                             'quantity', v_order.quantity, 'reorder', v_state IN ('ordered','shipped'),
                             'bundle_key', p_bundle_key, 'line_index', COALESCE(p_line_index, 0)));

  RETURN v_order;
END;
$$;

REVOKE ALL ON FUNCTION press_place_order(UUID, TEXT, INTEGER, JSONB, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
