-- press: an issue somebody else can read.
--
-- Link-based, not an access list. The audience is people V is sending a link
-- to anyway, and a per-friend grant would be a second thing to maintain for a
-- guarantee nobody asked for — anyone who has the link was given it.
--
-- Deliberately one flag and not two. "Anyone with the link" and "listed on my
-- shelf" sound like different settings and are not: the shelf at
-- /press/by/<handle> is a page anyone can open, so an issue listed there is
-- an issue anyone can read, and pretending otherwise would be a privacy
-- setting that does not do what it says.
--
-- Read-only is not enforced here. It falls out of 018: every editing route
-- resolves its issue through the caller's own scoped client, so a stranger
-- POSTing to /api/press/issue/3/lock gets a 404 for an issue that exists,
-- which is the correct answer. This column only decides what the two reading
-- pages will show.
--
-- See docs/plans/2026-09-03-004-feat-press-sharing-plan.md §5.

ALTER TABLE press_issues
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private','shared'));

-- When it started being readable. Not for display — for answering "how long
-- has this been out there" if that ever needs answering.
ALTER TABLE press_issues ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;

-- The shelf reads exactly these, newest first.
CREATE INDEX IF NOT EXISTS press_issues_shared_idx
  ON press_issues (owner_id, number DESC)
  WHERE visibility = 'shared';

NOTIFY pgrst, 'reload schema';
