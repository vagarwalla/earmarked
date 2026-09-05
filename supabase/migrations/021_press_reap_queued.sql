-- press: give up on a render nobody ever claimed.
--
-- `press_reap_jobs` only ever failed jobs stuck `running` — a machine that
-- died mid-render. It said nothing about the other way a job dies, which is
-- the one that actually happened: the Fly worker is not running, so pressing
-- Lock wrote a `queued` row that was never claimed, and the partial unique
-- index in 017 then refused every later press for that issue. The button was
-- dead, permanently, with no way back short of the SQL editor — and the
-- workbench, which resumes live jobs on load, kept picking the abandoned row
-- up and reporting a render that was not happening.
--
-- A queued job gets longer than a running one before it is given up on: it has
-- not failed at anything, it is waiting its turn behind however many renders
-- are ahead of it, and each of those is minutes. Two hours is comfortably past
-- a full queue and comfortably short of "until someone notices".
-- Dropped rather than replaced: a second argument makes this a new signature,
-- so CREATE OR REPLACE would leave 017's one-argument version in place beside
-- it. Both take only defaults, and `rpc('press_reap_jobs')` with no arguments
-- would then be ambiguous — an error, on the call that is supposed to be the
-- way out of a stuck queue.
DROP FUNCTION IF EXISTS press_reap_jobs(INTERVAL);

CREATE OR REPLACE FUNCTION press_reap_jobs(
  p_stale    INTERVAL DEFAULT INTERVAL '30 minutes',
  p_unclaimed INTERVAL DEFAULT INTERVAL '2 hours'
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_running     INTEGER;
  v_queued      INTEGER;
  v_stale_state INTEGER;
BEGIN
  UPDATE press_jobs
     SET state = 'failed',
         error = 'The machine rendering this stopped answering. Try again.',
         finished_at = now()
   WHERE state = 'running'
     AND COALESCE(heartbeat_at, started_at, created_at) < now() - p_stale;
  GET DIAGNOSTICS v_running = ROW_COUNT;

  UPDATE press_jobs
     SET state = 'failed',
         error = 'No renderer ever picked this up. Try again once one is running.',
         finished_at = now()
   WHERE state = 'queued'
     AND created_at < now() - p_unclaimed;
  GET DIAGNOSTICS v_queued = ROW_COUNT;

  -- A queued job for an issue that is no longer a draft can never succeed:
  -- /rebuild and /lock both refuse a closed issue, and so does the worker when
  -- it gets there. Leaving it queued means the one-live-job index keeps
  -- refusing new jobs for an issue whose only obstacle is a row describing
  -- work that is already done. `queued` only — a `lock` that is *running* is
  -- what closed the issue, and failing it would be failing the job that
  -- succeeded.
  UPDATE press_jobs j
     SET state = 'failed',
         error = 'The issue was no longer a draft by the time this came up.',
         finished_at = now()
   WHERE j.state = 'queued'
     AND EXISTS (
       SELECT 1 FROM press_issues i WHERE i.id = j.issue_id AND i.state <> 'open'
     );
  GET DIAGNOSTICS v_stale_state = ROW_COUNT;

  RETURN v_running + v_queued + v_stale_state;
END;
$$;

REVOKE ALL ON FUNCTION press_reap_jobs(INTERVAL, INTERVAL) FROM PUBLIC, anon, authenticated;
