-- press — one approval link may cover several issues.
--
-- 015 made a Lulu job able to carry several issues. This makes the *approval*
-- able to: a bundle is one job, bought in one act, and it is approved by one
-- link. A link per issue would be several chances to buy half a parcel — which
-- is the outcome the all-or-nothing rule exists to prevent, and which would
-- spend the saving that was the reason for bundling in the first place.
--
-- Deliberately NOT a token→issue join table. A token is written once, read
-- twice (the confirmation page, then the POST that spends it) and never
-- queried across; a join table would add a round trip to both reads to hold a
-- list that is fixed at insert. An array is the shape of the fact.
--
-- issue_id stays, and stays NOT NULL. It is the ON DELETE CASCADE that keeps
-- tokens from outliving their issue, and it is what the confirmation page has
-- always read; for a bundle it is simply the first issue of the list.

ALTER TABLE press_action_tokens
  -- Every issue the link acts on, issue_id included. Empty only for rows
  -- written before this migration, which the backfill below then fills.
  ADD COLUMN IF NOT EXISTS issue_ids UUID[] NOT NULL DEFAULT '{}';

-- Expiry — the thing that stops a re-composed issue being approved through a
-- link describing the previous version of it — matches on this array and
-- nothing else. A row left empty would be a live token that no recompose could
-- ever invalidate, so every existing row gets the list it always implied.
UPDATE press_action_tokens
   SET issue_ids = ARRAY[issue_id]
 WHERE issue_ids = '{}';

-- Expiry is a containment query per issue, run every time an approval email
-- goes out.
CREATE INDEX IF NOT EXISTS press_action_tokens_issue_ids_idx
  ON press_action_tokens USING GIN (issue_ids);

NOTIFY pgrst, 'reload schema';
