-- press: `skipped` is a decision, not a failure.
--
-- The local pipeline marks reference pages — an About page, a docs index —
-- `skipped` with a reason, rather than dropping them: the call is V's, and
-- they stay listed so one can be pulled back in. See isReferencePage() in
-- scripts/press-run.ts.
--
-- 009's state machine had nowhere to put that, so migrating the local state
-- would have had to record a deliberate exclusion as a failed extraction —
-- which reads as "this broke" in the digest and in "Not included" on /press,
-- and would be wrong.

ALTER TABLE press_items
  DROP CONSTRAINT IF EXISTS press_items_state_check;

ALTER TABLE press_items
  ADD CONSTRAINT press_items_state_check
  CHECK (state IN ('queued','extracted','laid_out','in_issue','printed','failed','skipped'));

COMMENT ON COLUMN press_items.state IS
  'queued -> extracted -> laid_out -> in_issue -> printed; any -> failed (extraction broke, reason recorded); laid_out -> skipped (deliberately excluded, e.g. a reference page).';
