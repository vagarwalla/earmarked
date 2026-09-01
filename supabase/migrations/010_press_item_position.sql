-- press: an issue's running order, made explicit.
-- See docs/plans/2026-08-31-002-feat-press-issue-editor-plan.md.
--
-- 009 made membership explicit (press_items.issue_id) but left the *order*
-- implicit: itemsForIssue sorted by published_at then created_at, so the
-- printed running order was whatever chronology happened to produce. The
-- editor at /press lets that order be changed, which needs somewhere to put it.
--
-- Mirrors `itemIds` in the local pipeline's .press/state.json, where position
-- in the array is position in the magazine — so the local editor and the
-- deployed one share one model.

ALTER TABLE press_items
  ADD COLUMN IF NOT EXISTS position INTEGER;

COMMENT ON COLUMN press_items.position IS
  'Running order within issue_id, 0-based. NULL means never ordered by hand; readers fall back to chronological so an un-edited issue is unchanged.';

-- Ordering is always "the items of one issue, in order", so the index carries
-- both columns. NULLs sort last, matching the reader's fallback.
CREATE INDEX IF NOT EXISTS press_items_issue_position_idx
  ON press_items (issue_id, position NULLS LAST);

-- Two articles sharing a slot would make the running order ambiguous, and the
-- editor rewrites every position in one go, so a clash is a bug rather than a
-- race. Partial: NULL positions are the un-edited majority.
CREATE UNIQUE INDEX IF NOT EXISTS press_items_issue_position_uniq
  ON press_items (issue_id, position)
  WHERE issue_id IS NOT NULL AND position IS NOT NULL;

-- Backfill anything already assigned to an issue, so its first edit starts
-- from the order it would have printed in rather than from nothing.
WITH ordered AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY issue_id
           ORDER BY published_at ASC NULLS LAST, created_at ASC
         ) - 1 AS pos
  FROM press_items
  WHERE issue_id IS NOT NULL
)
UPDATE press_items AS i
   SET position = ordered.pos
  FROM ordered
 WHERE i.id = ordered.id
   AND i.position IS NULL;
