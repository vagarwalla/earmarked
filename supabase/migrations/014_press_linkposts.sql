-- press: linkposts — a saved article that is really a set of pointers.
--
-- Some of what lands in `hw` is not a piece of writing but a set of pointers at
-- other writing: a links roundup, "assorted links", a crosspost that exists to
-- say "this is a linkpost for X". Printed as-is those become pages of anchor
-- text with the anchors removed — extract.ts drops every href, because print
-- cannot follow one — so the reading the post pointed at is simply lost.
--
-- The pipeline now fetches what a linkpost names and prints those pieces after
-- it. That needs two facts on a row: whether it is a linkpost, and which
-- linkpost brought it here.
--
-- Applies on top of 013 (workbench), whose press_set_issue_order and
-- press_drop_item this replaces — both are redefined in full below, so applying
-- 014 without 013 will fail on the constraint 013 creates.
--
-- See src/lib/press/linkpost.ts.

ALTER TABLE press_items
  ADD COLUMN IF NOT EXISTS is_linkpost BOOLEAN NOT NULL DEFAULT FALSE,
  -- SET NULL, never CASCADE: a piece fetched from a roundup is a real article
  -- with its own pages. Dropping the roundup must not delete the reading.
  ADD COLUMN IF NOT EXISTS linkpost_parent_id UUID REFERENCES press_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linkpost_anchor TEXT,
  ADD COLUMN IF NOT EXISTS linkpost_scanned_at TIMESTAMPTZ;

COMMENT ON COLUMN press_items.is_linkpost IS
  'This item points at other writing; the items whose linkpost_parent_id is this id are what it named.';
COMMENT ON COLUMN press_items.linkpost_parent_id IS
  'The linkpost that named this item. Its children print directly behind it in an issue.';
COMMENT ON COLUMN press_items.linkpost_anchor IS
  'The words the parent linkpost pointed with — the label when the piece has no better title yet.';
COMMENT ON COLUMN press_items.linkpost_scanned_at IS
  'When this item was last examined for linkposting. NULL means never asked, which is what the backfill walks — distinct from is_linkpost = false, which is an answer.';

-- Reading an issue means asking "what did this linkpost bring in", once per
-- linkpost, so the index is on the parent.
CREATE INDEX IF NOT EXISTS press_items_linkpost_parent_idx
  ON press_items (linkpost_parent_id)
  WHERE linkpost_parent_id IS NOT NULL;

-- The backfill's worklist: everything already extracted that has never been
-- examined. Partial, because after the backfill has run this index is empty,
-- which is exactly what it should cost then.
CREATE INDEX IF NOT EXISTS press_items_linkpost_unscanned_idx
  ON press_items (created_at)
  WHERE linkpost_scanned_at IS NULL;

-- ── The running order, with linkposts kept whole ─────────────────────────────
-- 013's press_set_issue_order takes whatever order the editor sends. A
-- linkpost's children must sit directly behind it, and that invariant is
-- imposed in TypeScript (orderWithLinkposts) so one definition serves both the
-- local pipeline and this one. What Postgres adds is the half TypeScript
-- cannot: a child cannot be placed in an issue its parent is not in, so no
-- arrangement can leave a piece captioned "Linkpost of …" pointing at nothing.
--
-- Note that nothing calls this yet — db.ts's setIssueOrder still writes the
-- positions itself, exactly as 013 found it. The guard is here so that it is
-- already true whenever that call site moves to the RPC, and so the two
-- definitions of the running order cannot be brought into step by accident.
CREATE OR REPLACE FUNCTION press_set_issue_order(p_issue_id UUID, p_item_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_state TEXT;
  v_count INTEGER;
  v_orphan TEXT;
BEGIN
  SELECT state INTO v_state FROM press_issues WHERE id = p_issue_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'press_set_issue_order: no such issue %', p_issue_id;
  END IF;
  IF v_state <> 'open' THEN
    RAISE EXCEPTION 'press_set_issue_order: issue % is not a draft', p_issue_id;
  END IF;

  -- A piece a linkpost brought in cannot be placed without the linkpost.
  SELECT COALESCE(i.title, i.url) INTO v_orphan
    FROM press_items i
   WHERE i.id = ANY (p_item_ids)
     AND i.linkpost_parent_id IS NOT NULL
     AND NOT (i.linkpost_parent_id = ANY (p_item_ids))
   LIMIT 1;

  IF v_orphan IS NOT NULL THEN
    RAISE EXCEPTION 'press_set_issue_order: "%" is here because a linkpost pointed at it, and that linkpost is not in this issue', v_orphan;
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
         position = o.ord,
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

-- Dropping a linkpost returns what it brought in to the pool unattached: the
-- pieces are real articles and worth keeping, but nothing points at them any
-- more, so the label on their opener would be false. 013's press_drop_item is
-- otherwise unchanged.
CREATE OR REPLACE FUNCTION press_drop_item(p_item_id UUID, p_archive_collection_id TEXT)
RETURNS press_items
LANGUAGE plpgsql
AS $$
DECLARE
  v_item press_items;
  v_orphaned INTEGER := 0;
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
     SET linkpost_parent_id = NULL, linkpost_anchor = NULL, updated_at = now()
   WHERE linkpost_parent_id = p_item_id;
  GET DIAGNOSTICS v_orphaned = ROW_COUNT;

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
          jsonb_build_object('archive_collection_id', p_archive_collection_id,
                             'linkpost_children_released', v_orphaned));

  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION press_set_issue_order(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION press_drop_item(UUID, TEXT) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
