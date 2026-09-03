-- press: room for a second person.
--
-- Every table in press assumes there is exactly one reader, and two of the
-- assumptions are structural rather than cosmetic:
--
--   press_items_url_key_uniq is globally unique on the normalised URL, and
--   insertItem upserts with ignoreDuplicates. The first time a friend adds a
--   link V has already saved, their copy is silently dropped and nothing
--   reports why. That is the bug this migration is really about.
--
--   press_settings has one row by construction — `id BOOLEAN PRIMARY KEY
--   CHECK (id)` — so there is one shipping address in the world.
--
-- Ownership hangs off press_accounts rather than off auth.users directly.
-- press keeps its own identity table because an invitation has to exist before
-- the person accepts it: V adds a row, they sign in later, and the sign-in
-- attaches auth_user_id to the row that was already waiting. It also means
-- this migration can seed the owner without an auth.users row existing yet.
--
-- See docs/plans/2026-09-03-004-feat-press-sharing-plan.md §2.

-- ── Accounts ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS press_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Attached at first sign-in, not here: a Supabase Auth user is created by
  -- signing in, and an invitation must be able to precede that.
  auth_user_id  UUID UNIQUE,

  -- The invitation. Deliberately nullable and deliberately not written by this
  -- file: the repo is public, so addresses are set with `npm run press:invite`
  -- and never committed. An account with no email cannot be signed in to.
  email         TEXT,
  -- The public half of the name: /press/by/<handle>.
  handle        TEXT NOT NULL,
  display_name  TEXT,

  -- Ordering spends money from an account on file at Lulu, and there is one of
  -- those. False for everybody who is not V; see the plan's §6.
  can_order     BOOLEAN NOT NULL DEFAULT FALSE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive on both: an address is not a different address for being
-- typed in capitals, and two handles differing only in case would be two URLs
-- for the same shelf.
CREATE UNIQUE INDEX IF NOT EXISTS press_accounts_email_key
  ON press_accounts (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS press_accounts_handle_key
  ON press_accounts (lower(handle));

ALTER TABLE press_accounts ENABLE ROW LEVEL SECURITY;

-- The owner, with a literal id so the backfill below is deterministic and this
-- file can be applied twice without inventing a second account.
INSERT INTO press_accounts (id, handle, display_name, can_order)
VALUES ('00000000-0000-0000-0000-000000000001', 'vaidehi', 'Vaidehi', TRUE)
ON CONFLICT (id) DO NOTHING;

-- ── owner_id, everywhere that holds someone's reading ────────────────────────
-- Nullable first, backfilled, then NOT NULL — all in one transaction, so there
-- is no window in which a row exists without an owner.

ALTER TABLE press_issues ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES press_accounts(id);
ALTER TABLE press_items  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES press_accounts(id);
ALTER TABLE press_events ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES press_accounts(id);
ALTER TABLE press_orders ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES press_accounts(id);
ALTER TABLE press_jobs   ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES press_accounts(id);

UPDATE press_issues SET owner_id = '00000000-0000-0000-0000-000000000001' WHERE owner_id IS NULL;
UPDATE press_items  SET owner_id = '00000000-0000-0000-0000-000000000001' WHERE owner_id IS NULL;
UPDATE press_events SET owner_id = '00000000-0000-0000-0000-000000000001' WHERE owner_id IS NULL;
UPDATE press_orders SET owner_id = '00000000-0000-0000-0000-000000000001' WHERE owner_id IS NULL;
UPDATE press_jobs   SET owner_id = '00000000-0000-0000-0000-000000000001' WHERE owner_id IS NULL;

ALTER TABLE press_issues ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE press_items  ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE press_orders ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE press_jobs   ALTER COLUMN owner_id SET NOT NULL;

-- press_events stays nullable, alone among these. The worker records
-- `worker_error` against nobody's press — a Raindrop poll that failed, a
-- scheduler that threw — and forcing an owner onto those would mean either
-- inventing one or losing the only trace of a broken pipeline.

CREATE INDEX IF NOT EXISTS press_issues_owner_idx ON press_issues (owner_id, number DESC);
CREATE INDEX IF NOT EXISTS press_items_owner_idx  ON press_items (owner_id, state);
CREATE INDEX IF NOT EXISTS press_events_owner_idx ON press_events (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS press_orders_owner_idx ON press_orders (owner_id, placed_at DESC);

-- press_action_tokens gets no owner, on purpose. A token is followed from an
-- email on a phone by somebody who is not signed in to anything; the token
-- *is* the authority, and the issue it names carries the owner. Scoping the
-- table would mean the approval link could only be opened by a session, which
-- is exactly what it exists to avoid.

-- ── The uniqueness that was one person's ─────────────────────────────────────

-- The bug. Two people may save the same essay; it is two articles, because it
-- will be printed in two magazines.
--
-- Not partial, unlike the index it replaces. `insertItem` upserts with
-- `onConflict`, and PostgREST emits a bare `ON CONFLICT (owner_id, url_key)`
-- with no predicate — which Postgres refuses to match against a *partial*
-- index, because inferring one requires restating its WHERE clause. The
-- predicate was never buying anything anyway: a plain unique index already
-- treats NULLs as distinct, so any number of items with no URL (newsletters,
-- emailed PDFs) still coexist.
DROP INDEX IF EXISTS press_items_url_key_uniq;
DROP INDEX IF EXISTS press_items_owner_url_key_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS press_items_owner_url_key_uniq
  ON press_items (owner_id, url_key);

-- Issue numbers count within a press, so a friend's first issue is Issue 1.
DROP INDEX IF EXISTS press_issues_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS press_issues_owner_number_key
  ON press_issues (owner_id, number);

-- press_orders_idempotency_key stays globally unique. The keys are random, and
-- "never place this order twice" is a property of the key, not of who holds it.

-- One live compose per issue was already per-issue and so already per-owner.

-- ── Settings: one row each, not one row ──────────────────────────────────────

ALTER TABLE press_settings ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES press_accounts(id);
UPDATE press_settings SET owner_id = '00000000-0000-0000-0000-000000000001' WHERE owner_id IS NULL;

DO $$
BEGIN
  -- Idempotent: applying this file twice must not try to drop a primary key
  -- that is already the one we want.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'press_settings' AND column_name = 'id'
  ) THEN
    ALTER TABLE press_settings DROP CONSTRAINT IF EXISTS press_settings_pkey;
    ALTER TABLE press_settings ALTER COLUMN owner_id SET NOT NULL;
    ALTER TABLE press_settings ADD PRIMARY KEY (owner_id);
    ALTER TABLE press_settings DROP COLUMN id;
  END IF;
END
$$;

-- ── Cursors: one Raindrop poll each ──────────────────────────────────────────
-- Only V polls Raindrop today, but the cursor is per-source-per-account the
-- moment a second person connects one, and a shared cursor would have each of
-- them skipping the other's unread drops.

ALTER TABLE press_cursors ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES press_accounts(id);
UPDATE press_cursors SET owner_id = '00000000-0000-0000-0000-000000000001' WHERE owner_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'press_cursors' AND constraint_type = 'PRIMARY KEY'
       AND constraint_name = 'press_cursors_pkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage
     WHERE table_name = 'press_cursors' AND constraint_name = 'press_cursors_pkey'
       AND column_name = 'owner_id'
  ) THEN
    ALTER TABLE press_cursors DROP CONSTRAINT press_cursors_pkey;
    ALTER TABLE press_cursors ALTER COLUMN owner_id SET NOT NULL;
    ALTER TABLE press_cursors ADD PRIMARY KEY (owner_id, source);
  END IF;
END
$$;

-- ── Functions that have to know whose press this is ──────────────────────────

-- Numbering within an account. The old zero-argument form is dropped rather
-- than left working: it would go on allocating from one global sequence, which
-- reads as a bug about a friend's first issue being number 7 and is really a
-- unique-violation waiting for the second account.
DROP FUNCTION IF EXISTS press_new_issue();

CREATE OR REPLACE FUNCTION press_new_issue(p_owner_id UUID)
RETURNS press_issues
LANGUAGE plpgsql
AS $$
DECLARE
  v_issue press_issues;
BEGIN
  INSERT INTO press_issues (owner_id, number, state)
  VALUES (
    p_owner_id,
    (SELECT COALESCE(MAX(number), 0) + 1 FROM press_issues WHERE owner_id = p_owner_id),
    'open'
  )
  RETURNING * INTO v_issue;

  INSERT INTO press_events (owner_id, issue_id, kind, detail)
  VALUES (p_owner_id, v_issue.id, 'issue_opened', jsonb_build_object('number', v_issue.number));

  RETURN v_issue;
END;
$$;

-- The one function that takes a list of ids from the client.
--
-- Everywhere else, an id reached this far by having been read back through an
-- owner-scoped query. Here the array arrives from a drag in a browser, and
-- without this check a crafted request could pull somebody else's article into
-- your issue — and, because the update also sets issue_id, out of theirs.
CREATE OR REPLACE FUNCTION press_set_issue_order(p_issue_id UUID, p_item_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_state TEXT;
  v_owner UUID;
  v_foreign INTEGER;
  v_count INTEGER;
BEGIN
  SELECT state, owner_id INTO v_state, v_owner FROM press_issues WHERE id = p_issue_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'press_set_issue_order: no such issue %', p_issue_id;
  END IF;
  IF v_state <> 'open' THEN
    RAISE EXCEPTION 'press_set_issue_order: issue % is not a draft', p_issue_id;
  END IF;

  SELECT count(*) INTO v_foreign
    FROM unnest(p_item_ids) AS wanted(item_id)
    JOIN press_items i ON i.id = wanted.item_id
   WHERE i.owner_id <> v_owner;
  IF v_foreign > 0 THEN
    RAISE EXCEPTION 'press_set_issue_order: % of those articles belong to somebody else', v_foreign;
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

-- ── RLS, as a backstop ───────────────────────────────────────────────────────
-- Enforcement is the owner-scoped client in src/lib/press/db.ts: everything
-- reaches these tables with the service-role key, which RLS does not apply to.
-- These policies buy nothing today. They are here so that the read-only
-- sharing pages can later be served with the anon key without the tables being
-- wide open the moment somebody tries it.

ALTER TABLE press_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS press_accounts_self ON press_accounts;
CREATE POLICY press_accounts_self ON press_accounts
  FOR SELECT USING (auth_user_id = auth.uid());

DROP POLICY IF EXISTS press_issues_own ON press_issues;
CREATE POLICY press_issues_own ON press_issues
  FOR SELECT USING (
    owner_id IN (SELECT id FROM press_accounts WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS press_items_own ON press_items;
CREATE POLICY press_items_own ON press_items
  FOR SELECT USING (
    owner_id IN (SELECT id FROM press_accounts WHERE auth_user_id = auth.uid())
  );

REVOKE ALL ON FUNCTION press_new_issue(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_set_issue_order(UUID, UUID[]) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
