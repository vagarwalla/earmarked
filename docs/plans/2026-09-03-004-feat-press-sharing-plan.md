---
title: "feat: press for other people — accounts, shared reading, and a PDF anyone can make"
date: 2026-09-03
revised: 2026-09-03
built: 2026-09-03
status: built
type: feat
depends_on: 2026-08-31-003-feat-press-workbench-plan.md
---

# feat: press for other people

## Summary

press is one person's magazine. V's reading goes in, an issue comes out, and
every table, index and route in it assumes there is exactly one of her. This
plan makes room for friends: they get an account, they can read her issues but
never touch them, and they can paste a list of URLs and get back a printed-
ready PDF of their own.

Four things must be true afterwards:

- **Two people's presses do not touch.** A friend cannot see V's pool, edit her
  running order, or drop an article out of her locked issue — and a URL she has
  already printed does not silently swallow their copy of it.
- **A friend's first issue costs them one paste.** No Raindrop token, no email
  forwarding address, no newsletter allowlist. A textarea of links is the whole
  ingestion story for anyone who is not V.
- **The PDF is the finish line.** Cover and interior, rendered, downloadable.
  Nobody but V orders anything from Lulu, and nothing in the UI implies they
  can.
- **Rendering works when nobody has a laptop open.** Today the only machine
  that can compose an issue is V's; a friend has no such machine and never will.

Explicitly not in scope: friends ordering print copies. See "Scope boundaries".

---

## Where things stand

The relevant facts about the code as it is today, because three of them are
load-bearing and one of them is a bug the moment a second person exists.

**There are no accounts.** `src/middleware.ts` is HTTP Basic with a single
shared `PRESS_PASSWORD`, and the file's own comment says "the user half is
ignored; there is one reader". Nothing in the app has ever called Supabase
Auth. `@supabase/ssr` is in `package.json` and is imported by nothing.

**Every press table is single-tenant, and two indexes make that structural.**

| Constraint | Where | What it does to a second person |
|---|---|---|
| `press_items_url_key_uniq` on `(url_key)` | 009 | **The bug.** `insertItem` upserts with `ignoreDuplicates: true`, so a friend pasting a link V has already saved gets a silent no-op — their article never appears and nothing reports why |
| `press_issues_number_key` on `(number)` | 009 | Issue numbers are one global sequence. A friend's first issue is "Issue 7" |
| `press_settings.id BOOLEAN PRIMARY KEY CHECK (id)` | 013 | There is one settings row in the world, by construction |
| `press_cursors.source` as PK | 009 | One Raindrop cursor. Fine — only V polls Raindrop |
| `press_new_issue()` | 013 | Allocates `max(number) + 1` across the whole table |

`press_issues_single_open` was dropped in 013, so many drafts at once is
already allowed. That one is not in the way.

**Nothing can render an issue except V's laptop.** `POST /api/press/issue/
[number]/rebuild` returns a deliberate 501 when `reviewSource() === 'supabase'`,
with the message "Rebuilding needs a machine with a browser. Run press-run
locally, then re-import." The Fly worker has Chromium and renders per-article
fragments, but the compose step was moved out of it into the workbench on
purpose (see 003 §9) — and the workbench, deployed, is a Vercel function that
cannot render. So the deployed app has no path from a full pool to a PDF at
all, for V or anyone.

**The composer, though, does not care whose machine it is on.** `composeIssue()`
reads articles from Storage and writes `issues/<id>/interior.pdf` and
`cover.pdf` back to Storage. It has no disk dependency. It needs a browser and
nothing else. That is the whole reason this plan is tractable.

**Ingestion is Raindrop and email only.** Both run on V's credentials. There is
no route anywhere that takes a URL from a form.

---

## The shape

```
  friend signs in (magic link)
        │
        ▼
  /press ── their workbench, their pool, their issues
        │         (identical component tree; owner is the only difference)
        │
        ├── paste a block of URLs ──► press_items (queued, owner = them)
        │                                   │
        │                            Fly worker: extract → lay out → laid_out
        │                                   │
        ├── arrange an issue ──────────────►│
        │                                    ▼
        ├── "Make the PDF" ──► press_jobs(compose) ──► Fly worker: composeIssue()
        │                                                     │
        │                                              cover.pdf + interior.pdf
        │                                                     │
        └── download ◄────────────────────────── signed Storage URLs

  /press/by/vaidehi ── read-only: V's shared issues, TOC and PDF, no buttons
```

---

## Design

### 1. Accounts: Supabase Auth, magic link, invite-only

Supabase Auth is already sitting in the project unused, `@supabase/ssr` is
already a dependency, and `auth.users` gives a stable UUID to hang ownership
off. Magic link because a password is a support burden for an audience of
about six people, and because none of them will remember it.

Invite-only, via a `press_accounts` row that must exist before a sign-in is
honoured. Not because the data is precious, but because every account is a
person who can make the Fly machine render a hundred pages and can make this
app fetch arbitrary URLs on their behalf. An open sign-up turns both of those
into someone else's resource. V adds a row; they can then sign in.

`press_accounts` also carries the `handle` that `/press/by/<handle>` uses, and
a `can_order` flag that is true only for V (see §6).

The Basic-auth middleware comes out in the same change that puts auth in. It
must not survive alongside sessions: a `PRESS_PASSWORD` still set would gate
the friends' sign-in page behind a password they do not have, and a
`PRESS_PASSWORD` unset while the session check is half-wired is the whole press
open to the internet. One PR, both halves.

### 2. Ownership: a column on everything, and a client that cannot forget it

`owner_id UUID NOT NULL REFERENCES auth.users(id)` on `press_issues`,
`press_items`, `press_events`, `press_orders`, and `press_jobs`.
`press_settings` swaps its boolean primary key for `owner_id`.
`press_cursors` becomes `(owner_id, source)`.

The unique indexes are rebuilt per owner — `(owner_id, url_key)`,
`(owner_id, number)` — which is what fixes the swallowed-paste bug. Order
idempotency keys stay globally unique; they are random and shared uniqueness
costs nothing.

**Enforcement stays server-side, not RLS.** Every path in the app —
`db.ts`, `remote.ts`, `workbench.ts`, the worker, Storage reads — reaches
Postgres with the service-role key, and the press tables have RLS on with no
policies precisely so the anon key cannot see them. Switching to anon-key RLS
would mean rewriting all of that, plus Storage access, plus giving the browser
a client that can read press tables at all. The gain would be a database that
enforces the rule; the cost is a rewrite of every press query in a codebase
where the rule has never been needed before.

So instead: `pressDb()` becomes `pressDb(ownerId)` and returns a scoped
wrapper whose query helpers apply `.eq('owner_id', ownerId)` themselves. A
route that forgets to scope does not compile, because there is no unscoped
client to get hold of. RLS policies keyed to `auth.uid()` get added anyway as a
backstop and for the read-only share path in §5, but nothing depends on them.

This is the risky migration: it touches every press query and V's live data.
It goes in its own PR, with the backfill (`owner_id` = V's account for every
existing row) in the same migration, and `NOT NULL` added only after the
backfill in the same transaction.

`press_new_issue()` takes `p_owner_id` and numbers within it, so a friend's
first issue is Issue 1. `press_set_issue_order()` gains a check that every
item id belongs to the same owner as the issue — the one function that takes a
list of ids from the client and could otherwise be handed someone else's.

### 3. Rendering moves to the worker, as a job

This is the largest piece of real work and it is worth doing first, because it
is the only change here that is useful before any of the others land: it
removes the 501 and gives V a "Make the PDF" button that works from her phone.

A `press_jobs` table: `(id, owner_id, kind, issue_id, state, progress, error,
created_at, started_at, finished_at)` with `kind = 'compose'` for now and
`state` in `queued | running | done | failed`. One partial unique index on
`(issue_id) WHERE state IN ('queued','running')` so pressing the button twice
cannot start two renders of the same issue — the same guarantee `build.lock`
gives locally, expressed where both runtimes can see it.

The workbench posts a job and returns immediately. The worker's loop picks up
`queued` compose jobs, claims one atomically, runs `composeIssue()`, and writes
progress lines into the row as it goes. The page polls the job row. This
replaces the NDJSON stream, which was a good fit for a local build the browser
was directly driving and a bad one for a render happening on another continent
that must survive the tab closing.

The worker currently ticks every 15 minutes. Jobs need a separate, faster loop
— every 10 seconds, cheap because the query is one indexed lookup — so
"Make the PDF" does not sit for a quarter of an hour before starting.

`buildIssue()` and `.press/` stay exactly as they are. They are V's fast local
loop and there is no reason to take them away. But note the divergence: after
this there are two composers, and a change to the layout must land in both or
her local build and the deployed one produce different magazines. §9 of plan
003 chose one renderer for that reason and this walks it back — deliberately,
because "the deployed app cannot make a PDF" is the larger problem, but it is a
real cost and the follow-up is to retire the local path once the worker one is
trusted.

### 4. Bulk paste

`POST /api/press/items/paste`, a textarea in the pool panel, and a new
`'paste'` value on the `press_items.source` CHECK constraint.

Splits on whitespace and newlines, keeps anything that parses as an `http(s)`
URL, drops the rest and says how many it dropped. Deduplicates within the paste
and against the pasting owner's existing `url_key`s, and reports both counts —
"38 links: 31 added, 4 you already have, 3 that were not URLs" — because a
paste that silently absorbs half its input is the bug from §2 wearing a
different hat.

Capped at 50 URLs per paste and rate-limited per account per day. Each URL is a
server-side fetch of an address a user chose, which is the shape of an SSRF, so
the existing extractor's fetch path gets an explicit deny for private and
loopback ranges before this route ships. Extraction is unchanged after that:
the rows land as `queued` and the worker's existing `extractQueued()` finds
them.

The pool panel needs to show `queued` and `failed` items with their reasons.
Today it shows the pool, which is `laid_out` only — a friend who pastes ten
links and sees an empty pool for two minutes will paste them again.

### 5. Reading someone else's issues

`press_issues.visibility` — `private` (default) or `shared`. A shared issue is
readable by anyone who has the link; there is no per-friend access list,
because the audience is people V is sending a link to anyway.

Two read-only surfaces, both of which are new pages that call a new reader and
never touch `workbench.ts`:

- `/press/by/<handle>` — an owner's shared issues, newest first: number, name,
  date, cover, contents.
- `/press/i/<handle>/<number>` — one issue: the TOC, and a signed URL for the
  interior PDF.

Read-only is enforced by there being no mutation route that accepts someone
else's issue, not by hiding buttons. The §2 scoping already guarantees that:
every editing route resolves its issue through the caller's scoped client, so a
friend POSTing to `/api/press/issue/3/lock` gets a 404 for an issue that exists,
which is the correct answer.

The PDF link is a Storage signed URL with the existing one-hour TTL, minted per
request. Whether a shared issue's PDF should be downloadable at all, or only
readable page-by-page in the browser, is left open below.

### 6. Lulu, and what a friend sees instead

Ordering stays V's. `press_accounts.can_order` gates it, the order routes check
it, and for everyone else the order panel is not rendered — not disabled with a
tooltip, absent. A button that exists and refuses is a support question.

What a friend gets in its place, on a locked issue: cover and interior as two
downloadable PDFs, and a short note naming the trim size and binding
(`0700X1000.FC.STD.PB.060UW444.GXX` — 7×10, full-colour cover, perfect bound,
60# uncoated) so they can hand the files to Lulu, or any printer, themselves.
The schema is already ready for the eventual version of this: `press_orders`
has `ordered_by` and a snapshotted `ship_to`, with a comment saying "Yours
today. Someone else's when copies can be ordered by other people."

The Anthropic key that names issues is also V's, and a friend's issue would
spend it. Issue naming falls back to a date range when no key is configured, so
non-owner accounts take the fallback until there is a reason to do otherwise.
It is one model call per compose, so this can be revisited cheaply.

---

## Schema: migration 018

(017 is the job queue from step 1; ownership is 018.)

One migration, applied in this order, because the backfill has to sit between
the column and its `NOT NULL`:

1. `press_accounts (id UUID PK, auth_user_id UNIQUE, email, handle UNIQUE,
   display_name, can_order BOOLEAN DEFAULT FALSE, created_at)`; insert V's row
   at a literal id so the backfill is deterministic. Ownership hangs off this
   table rather than off `auth.users` directly, because an invitation has to
   precede the person accepting it — and because it lets the schema become
   multi-tenant before any sign-in exists. `email` is left NULL here and set
   with `npm run press:invite`: this repo is public.
2. `owner_id UUID REFERENCES auth.users(id)` — nullable — on `press_issues`,
   `press_items`, `press_events`, `press_orders`.
3. Backfill all four to V's user id.
4. `SET NOT NULL` on all four.
5. Drop and rebuild `press_items_url_key_uniq` as `(owner_id, url_key)` —
   **not partial**, unlike the index it replaces. `insertItem` upserts with
   `onConflict`, PostgREST emits a bare `ON CONFLICT (…)` with no predicate,
   and Postgres will not infer a partial index from one: it wants the WHERE
   clause restated. The predicate bought nothing anyway, since a plain unique
   index already treats NULLs as distinct. Same rebuild for
   `press_issues_number_key` → `(owner_id, number)`.
6. `press_settings`: add `owner_id`, backfill from the single row, drop the
   boolean PK, make `owner_id` the PK.
7. `press_cursors`: add `owner_id`, backfill, PK becomes `(owner_id, source)`.
8. `press_issues.visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility
   IN ('private','shared'))`.
9. `press_items.source` CHECK gains `'paste'`.
10. `press_jobs`, with its partial unique index.
11. `press_new_issue(p_owner_id UUID)`; owner check inside
    `press_set_issue_order`.
12. RLS policies keyed to `auth.uid()` on all press tables — backstop only.

**Applying it.** As with 013, the deployed worker runs against the same
database and will break between step 4 and a deploy that knows about
`owner_id`. Stop the Fly machine, apply, deploy both runtimes, restart. The
worker is stateless and every step of its pipeline is resumable, so stopping it
mid-tick costs nothing.

---

## Built

All seven landed on 2026-09-03, one PR each, in this order. Migrations 017–020.

| | | |
|---|---|---|
| 1 | Compose on the worker | `press_jobs`, a claimed job, progress polled instead of streamed; the 501 gone |
| 2 | SSRF guard | Already existed — `fetch.ts` resolves and refuses private addresses at every hop |
| 3 | Ownership | `owner_id` everywhere, `pressDb(owner)`, no default clients; the swallowed-paste bug fixed |
| 4 | Auth | Magic link, invite-only, Basic auth removed, project signups disabled |
| 5 | Bulk paste | A textarea, counts for everything that did not land, the "arriving" pile |
| 6 | Sharing | `visibility`, `/press/by/<handle>`, `/press/i/<handle>/<n>` |
| 7 | The friend's finish line | Two PDFs and a print spec; `can_order` enforced in the routes |

**What it still needs to work end to end: the Fly worker.** `press-worker` has
never existed — `flyctl apps list` shows one unrelated app. Without it a
deployed "Make the PDF" queues a job nothing will claim, and a pasted link
never gets extracted. Everything else is live. Deploying it is
`fly launch --no-deploy -c worker/fly.toml`, `fly secrets set …` from the
configuration table in the runbook, `fly deploy -c worker/fly.toml` — and about
$2–3/month for a machine that must never auto-stop.

Three answers the build found that the plan had wrong or missing:

- The SSRF work in step 2 was already done.
- The new dedupe index cannot be partial. PostgREST emits a bare `ON CONFLICT`
  and Postgres will not infer a partial index from one; the predicate bought
  nothing anyway, since NULLs are already distinct.
- Disabling project signups is load-bearing, and it needs `press:invite` to
  create the Supabase user. Checking the invite list inside the sign-in action
  is only half a gate: the anon key is in the page, so the same request can go
  straight to GoTrue.

---

## Build order

Each is a PR that lands on its own.

1. **Compose on the worker.** `press_jobs`, the job loop, the "Make the PDF"
   button, the 501 deleted. No auth, no ownership — this is V's own missing
   feature and it is the prerequisite for a friend ever seeing a PDF.
2. ~~**SSRF guard on the extractor's fetch.**~~ **Already done.** Every
   server-side fetch already goes through `src/lib/press/fetch.ts`, which
   refuses non-http(s) schemes, resolves every host and rejects any non-public
   address, re-checks each redirect hop, caps the body, and drops credentials
   across origins. The plan asserted a gap that is not there.
3. **Ownership.** Migration 017 steps 1–7 and 11, plus `pressDb(ownerId)` and
   the compile-error scoping. Everything still runs as V; nothing visible
   changes. The riskiest PR and the one worth reviewing hardest.
4. **Auth.** Magic link, sign-in page, `press_accounts` check, Basic-auth
   middleware removed. `/press` becomes per-account.
5. **Bulk paste.** The route, the textarea, `queued`/`failed` visibility in the
   pool.
6. **Sharing.** `visibility`, `/press/by/<handle>`, `/press/i/<handle>/<number>`.
7. **The friend's finish line.** `can_order` gating, the order panel hidden,
   the two PDF downloads and the print-spec note.

1 and 2 are useful the day they land. Nothing is shared with anyone until 6.

---

## Scope boundaries

**Not in this plan:**

- Friends ordering from Lulu. Explicitly deferred at V's instruction — the
  account, card and approval flow are hers, and per-friend payment is a
  different project. The eventual path is Lulu OAuth at order time, and
  `press_orders.ordered_by` is the column it lands in.
- Raindrop, email-in and Substack ingestion for friends. Those run on V's
  credentials. Friends get paste. Per-account Raindrop tokens are a follow-up
  and a settings form, not a redesign.
- Retiring `.press/` and `buildIssue()`. Follow-up once the worker composer has
  printed a real issue.
- Comments, following, any social surface. A link is the sharing mechanism.

---

## Risks

| Risk | Mitigation |
|---|---|
| The ownership migration touches every press query and V's live data | Its own PR; backfill and `NOT NULL` in one transaction; scoped client makes an unscoped query a type error rather than a silent leak |
| Server-side scoping is a rule the code must remember | The unscoped client is deleted, not deprecated. RLS policies as a second layer |
| Arbitrary-URL fetching on behalf of strangers | Already handled: `fetch.ts` resolves and refuses private, loopback and link-local addresses at every redirect hop. What is left is rate limiting — invite-only accounts and a per-account daily cap |
| One 1GB Fly machine renders every account's issues | The job queue serialises by construction; at six friends this is a feature. Revisit if a queue ever backs up |
| Two composers drift | Named as a known cost; retiring the local one is the follow-up |
| Storage grows with every account's articles and PDFs | Not addressed here. Worth a size check before the invite list goes past a handful |
| V's Anthropic key spent naming friends' issues | Non-owner accounts take the date-range fallback |

---

## Decided

- Supabase Auth with magic links, invite-only via `press_accounts`. Not a
  second shared password, and not open sign-up.
- Ownership enforced by a scoped server-side client, with RLS as a backstop —
  not by moving press to the anon key.
- Compose moves to the Fly worker as a polled job, not as a longer Vercel
  function and not as a streamed request the browser has to stay attached to.
- Sharing is link-based visibility on an issue, not an access list.
- Friends' ingestion is paste only.
- The friend's deliverable is two PDFs and a print spec, and the order panel is
  absent rather than disabled.

## Still open

- ~~Should a shared issue's interior PDF be downloadable?~~ **Built
  downloadable**, as the simpler thing and as what the signed-URL code already
  did. Worth revisiting only if it starts to matter that anything shared can be
  reprinted by whoever has the link — the page says the links expire in an
  hour, which is the honest half of it.
- Does a friend get the linkpost expansion — a roundup printing the pieces it
  names — on pasted URLs? It is the most distinctive thing press does and it is
  also several model calls per linkpost on V's key.
- ~~Handles: chosen by the friend, or assigned by V?~~ **Assigned**, as an
  argument to `npm run press:invite`. Less code and one fewer uniqueness race,
  as expected.
- Does V want to see friends' issues, or is the read direction one-way?
