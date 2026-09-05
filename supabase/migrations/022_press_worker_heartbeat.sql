-- press: somewhere for the renderer to say it exists.
--
-- The website has never had a way to tell "the worker is busy" from "there is
-- no worker". Both look identical from a Vercel function: /lock writes a
-- `queued` row and answers 202, and the button waits. When the Fly machine is
-- actually running that wait is a minute; when it is not — parked on billing,
-- mid-deploy, or never started — the wait is forever, and the row sits there
-- holding 017's one-live-job index against every later press for that issue.
--
-- `started_at` on a job cannot answer it: an idle worker with an empty queue
-- claims nothing for days and is perfectly alive. So the worker says so
-- directly, on the loop it runs whether or not there is work to do.
--
-- One row, overwritten. There is one renderer; a history of its heartbeats
-- would be the largest table in the schema and nobody would read it.
CREATE TABLE IF NOT EXISTS press_workers (
  id           TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail       JSONB
);

ALTER TABLE press_workers ENABLE ROW LEVEL SECURITY;

-- Not owner-scoped, and deliberately: the renderer is one machine serving
-- every account, so "is there a renderer" has the same answer for everybody.
-- Service-role only, like the rest of press.
