-- press: an article that arrived as a pasted link.
--
-- Raindrop and the email door both run on V's credentials, so neither is a way
-- in for anybody else. A textarea is: paste a block of links, and the worker's
-- existing extraction treats them exactly as it treats a drop.
--
-- The state machine is unchanged — these land `queued` like everything else.
-- Only the provenance is new, and it is worth recording rather than filing
-- under 'raindrop': how something arrived is what tells you why it failed.
--
-- See docs/plans/2026-09-03-004-feat-press-sharing-plan.md §4.

ALTER TABLE press_items DROP CONSTRAINT IF EXISTS press_items_source_check;
ALTER TABLE press_items ADD CONSTRAINT press_items_source_check
  CHECK (source IN ('raindrop','email_link','newsletter','pdf','x','paste'));

NOTIFY pgrst, 'reload schema';
