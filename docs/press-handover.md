# press — handover, 2026-09-04

What was built to let other people use press, what state it is in, and what is
left. Written at the end of the session that built it, for whoever picks it up
next — including a future Claude.

The design reasoning is in
[the plan](plans/2026-09-03-004-feat-press-sharing-plan.md). How to operate it
is in [the runbook](press-runbook.md). This is the bit neither of those covers:
**what is unfinished, and what to watch out for.**

---

## Short version

The code is done and deployed. It does not work end to end yet, because the
machine that renders PDFs and fetches saved links **has never been deployed**.

- On a laptop, everything works.
- On the live site, everything works except the two things that need that
  machine: articles do not get fetched, and PDFs do not get made.

One thing to do, and it is not code: deploy the Fly worker.

---

## What was built

Nine PRs, migrations 017–020, all on `main`.

| | | Works? |
|---|---|---|
| Compose on the worker | A render is a `press_jobs` row the worker claims, polled rather than streamed, so it survives closing the tab | Locally ✅ · Deployed ❌ (no worker) |
| Ownership | `owner_id` on every table; `pressDb(owner)` scopes every query and there is no unscoped default | ✅ |
| Sign-in | Supabase magic link, open to anyone | ✅ |
| Bulk paste | Paste links into the pool, capped 50/paste and 200/day per account | Accepts ✅ · Fetches ❌ (no worker) |
| Sharing | `/press/by/<handle>` and `/press/i/<handle>/<n>`, read-only | ✅ |
| Friend's finish line | Two PDFs and a print spec instead of an order button | ✅ |
| Owner's own way in | Localhost needs nothing; deployed uses a bookmark or a key | ✅ |

---

## The one real gap: the Fly worker

`press-worker` does not exist. `flyctl apps list` shows one unrelated app.

Nothing claims jobs and nothing extracts links, so on the deployed site:

- **66 articles are stuck `queued`** — pasted or named by a linkpost, never
  fetched. They are not lost; they are waiting.
- **One compose job for issue 9 has been queued since 2026-09-04 00:02** and
  will sit there. The one-live-job index means the Rebuild button on issue 9
  refuses until it clears — `SELECT press_reap_jobs('1 minute');` clears it, or
  the worker will when it starts.
- Order status never refreshes, the weekly digest never sends, and printed
  issues are never archived back to Raindrop.

None of this affects the laptop, which renders locally and always has.

### Deploying it

```bash
fly launch --no-deploy -c worker/fly.toml
fly secrets set -a press-worker …        # the table in docs/press-runbook.md
fly deploy -c worker/fly.toml
fly logs -a press-worker                 # expect: worker_started
```

About **$2–3/month**. The machine must never auto-stop — the scheduler runs
in-process, so a suspended machine is a stopped pipeline. `worker/fly.toml`
already sets `auto_stop_machines = false` and `min_machines_running = 1`.

Once it is up, the 66 queued articles drain on the next pass (25 at a time,
every 30 minutes) and the stuck job is claimed within 10 seconds.

**Check first:** a worker deployed from before migration 018 will insert items
with no `owner_id` and fail on the NOT NULL. Deploy from current `main`.

---

## Loose ends

**`PRESS_OPEN_OWNER` is in a git stash, not a branch.** The "no credential at
all on the deployed site" flag was written and never merged: the sandbox
blocked builds of it, so it is unverified, and unverified auth code should not
land. It is at `git stash list` → `stash@{0}`. A stash is a fragile place to
keep work — either finish it (`git stash pop` on a branch, build, test) or drop
it. Do not merge it unbuilt.

**Issue 1 was not rebuilt.** It is `closed`, and a closed issue's PDFs are what
its contents were frozen against. Every other issue was re-rendered against the
current templates on 2026-09-04. To include it: unlock it, then
`npm run press:sync -- --no-poll --force`.

**Issue 1 is currently `shared`** — readable by anyone with the link at
`/press/i/vaidehi/1`. Nobody in this session shared it. Worth confirming that
is intentional; the switch is on the issue in the workbench.

**Two composers now exist.** `buildIssue` renders from `.press/` on the laptop;
`composeIssue` renders from Storage on the worker. A change to `press.css` or
the templates must land in both, or the laptop and the website produce
different magazines. Plan §3 says the follow-up is retiring the local one once
the worker path has printed a real issue. It has not yet.

**Storage is uncapped.** Every account's articles and PDFs share one bucket, and
sign-up is open. Worth a size check before this goes past a handful of people.

**Supabase's built-in mailer sends about two links an hour, project-wide.** That
throttles abuse and it throttles real friends: several signing up the same
evening will see "too many links requested". Configure SMTP if that happens.

---

## Traps this session hit, so the next one does not

**Next inlines `process.env.X` at build time in *server* chunks, not only
client ones.** A flag set when the server starts has no effect on code that
reads it the dotted way. `PRESS_REQUIRE_SIGN_IN` silently did nothing until it
was read as `process.env['PRESS_REQUIRE_SIGN_IN']`. There is an `env()` helper
in `src/lib/press/auth.ts` for exactly this; use it for anything read at
runtime.

**`pkill -f "next start"` does not kill the server.** `next start` forks a
`next-server` child that the pattern misses, so you keep testing the old
process and conclude your change did nothing. Kill by port:
`kill $(lsof -ti:3000)`.

**PostgREST emits a bare `ON CONFLICT`, which Postgres will not match against a
*partial* index.** Migration 018's first version made the dedupe index partial
and every insert failed. Unique indexes used as upsert targets must not have a
`WHERE`.

**Fake database objects in tests hide real column errors.** `settings-db.ts`
queried `press_settings.id` for hours after migration 018 dropped that column;
every test passed and `/press` 500'd. A production build against the real
database found it in one request. Run one before believing a schema change.

**Other Claude sessions are editing this repo at the same time.** Issue 1's
state changed under this session more than once. Re-read the tree before
committing, and prefer `git pull` before merging.

---

## How to check it is all still true

```bash
npm test                                     # 900+ tests
npm run build                                # a real build catches schema drift
npm run press:invite -- --list               # who has an account
fly status -a press-worker                   # does the worker exist yet?
```

And the live site: `https://earmarked.vercel.app/press` should show the
workbench if your browser has been through `/press/enter?key=…`, and the
sign-in page otherwise.
