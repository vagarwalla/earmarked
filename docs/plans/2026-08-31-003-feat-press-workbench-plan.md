---
title: "feat: press workbench — issues, pool, orders and settings on one screen"
date: 2026-08-31
revised: 2026-08-31
status: proposed
type: feat
depends_on: 2026-08-31-002-feat-press-issue-editor-plan.md
---

# feat: press workbench

## Summary

`/press` is a single column that lists issues newest-first and lets you edit the
one that is open. This turns it into a workbench: a rail of every issue on the
left, the issue you are working on in the middle, and a panel on the right that
holds the pool of unprinted articles, the orders you have placed, and the
address and mailing settings the orders are made from. Ordering stops being
"upload two PDFs at lulu.com by hand" and becomes a button.

Four things it must be true of afterwards:

- **The pool is the source of truth.** Articles live in the pool; issues are
  arrangements of them. Removing an article from an issue returns it to the
  pool. Permanent deletion happens only in the pool.
- **An issue can be locked.** Once locked, its contents are fixed, and only a
  locked issue can be printed.
- **Money is spent deliberately.** Order shows the quote, the shipping address
  and the email on file, then goes through the emailed approval link.
- **It is one path, not two.** Everything reads and writes Supabase, so the
  "other people can order copies" idea is a feature away rather than a rewrite.

---

## This is a rewrite

The first draft of this plan was written against a codebase that no longer
exists. Between then and now, `d1d7d6c` ("serve /press from Supabase so it
works deployed") landed and did a large part of what this plan called phase 1 —
but arrived at a different answer to the question the plan's §1 was about.

What the original got wrong about its own starting point, and what has changed:

| The plan said | Actually |
|---|---|
| "Supabase schema 009/010 already written" | 010 was never in the repo. It had been applied to the project by hand and existed only in the deployed database. `d1d7d6c` reconstructed it as three migrations — 010 (`position`), 011 (`skipped`), 012 (`built_order`) |
| `scripts/press-import.ts` is to be written | Written, and **run**: 33 items and issue 1 are in Postgres now |
| `/press` reads `.press/state.json` | Reads whichever `review.ts` picks — disk if `.press/state.json` exists, Supabase if not |
| The edit routes are local-only | `/api/press/issue/[number]` already has a Supabase branch (`applyRemote`) |
| `.press/` retires; `local.ts` / `issues.ts` go away | Both are alive and load-bearing. `review.ts` and `remote.ts` were added *beside* them |
| Question 2: does `/press` need auth? | **Still open.** `c7869e9` built the middleware, but `PRESS_PASSWORD` is not set anywhere — and unset means open, by that file's own design. The lock exists and is not engaged |
| Question 1: is anything running on its own? | **No.** `press-worker` has never existed on Fly — `flyctl apps list` shows one unrelated app. Nothing has ever run on its own |

The migration this plan needs — `013_press_workbench.sql` — is **already
committed**, having been swept into `d1d7d6c` by accident. It has not been
applied, and applying it right now would break the deployed worker. See
"Schema" below before running `npm run db:apply`.

---

## Where things stand

| | Today |
|---|---|
| Store | Both. Postgres has 33 items and issue 1; `.press/` has the same, and is still the only thing `press-run.ts` writes |
| What `/press` reads | `review.ts` → `local.ts` (disk) or `remote.ts` (Postgres), chosen by whether `.press/state.json` exists. `PRESS_SOURCE` forces either |
| What fills Postgres | `scripts/press-import.ts`, by hand, one way, from the disk |
| What fills the disk | `scripts/press-run.ts`, by hand |
| What else writes Postgres | The Fly worker, on its own schedule |
| Editing | Reorder / add / remove / rebuild, open issue only. Both sources |
| Ordering | Manual: download both PDFs, upload at lulu.com |
| Settings | Environment variables only (`PRESS_SHIP_*`, `PRESS_MAIL_TO`, …) |
| Order history | Nowhere |

Item states in Postgres right now: 17 `laid_out` and unplaced (the pool), 12
`in_issue` on issue 1, 3 `failed`, 1 `skipped`. Issue 1 is `open`, named "Moral
Seriousness and Doubt", 106 pages, built, with a `built_order` recorded.

### Nothing has ever run on its own — checked

Postgres held zero press rows until the import ran, which did not fit "the
worker is deployed and polling". It does not fit because it was not true:
`flyctl apps list` shows one app on the account, `vagarwalla-games`. **The
`press-worker` app has never been created.** `worker/`, its Dockerfile and its
fly.toml are all written, and none of it has ever been deployed.

Three consequences, and they simplify the plan rather than complicating it:

- **The sequencing problem was imaginary.** Migration 013 removes
  `press_bootstrap_issue`, and the worry was that a running worker would break
  on it, or worse keep running and sweep the pool into an open issue. There is
  no running worker. 013 was safe to apply the moment it was written, and has
  been applied.
- **The pool was never at risk.** `assignToOpenIssue` has never executed
  against this database.
- **Phase 1 does not end with a deploy.** It ends with a command you type. That
  was the third possibility this section originally offered, and it is the one
  that turned out to be true.

Which leaves a question the original plan never had to ask: **is the worker
worth deploying at all?** `press-sync` already does the round trip — pull the
running order, poll Raindrop, build, push back — from the machine that can
render, which the worker fundamentally cannot do without carrying Chromium.
What the worker would add is that it happens while you are asleep. What it
costs is a Fly app, its secrets, and ~$2–3/month for a machine that must never
auto-stop. Not obviously worth it for a magazine you assemble by hand every few
weeks; worth revisiting if the pool starts going stale between sessions.

---

## The shape

```
┌────────────────┬─────────────────────────────────┬──────────────────────────┐
│ ISSUES         │  Moral Seriousness and Doubt    │ POOL · ORDERS · SETTINGS │
│ ┌────────────┐ │  Issue 1 · draft · 106pp        │                          │
│ │ search…    │ │  ─────────────────────────────  │ 17 waiting  [search…]    │
│ └────────────┘ │  [Rebuild] [Lock] [Order]       │ ┌──────────────────────┐ │
│ all draft      │                                 │ │⠿ On sincerity     30p│ │
│ locked printed │  ⠿ 1  On sincerity          30p │ │  joecarlsmith.com  ×│ │
│                │  ⠿ 2  EA is about maximiz…   5p │ ├──────────────────────┤ │
│▸ #3  draft  12p│  ⠿ 3  Deference and moral…  14p │ │⠿ Moral error and…  9p│ │
│  #2  draft  47p│  ⠿ 4  …                         │ │  forum.effective…  ×│ │
│🔒 #1 locked 106│                                 │ ├──────────────────────┤ │
│  ✔ #0 shipped  │  106 / 100 pages ── ready       │ │⠿ …                   │ │
│                │                                 │ └──────────────────────┘ │
│                │  drop an article here ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ←   │
└────────────────┴─────────────────────────────────┴──────────────────────────┘
```

Drag runs right-to-left into the issue and left-to-right back out; the `×` in
the pool is the only permanent delete in the product. The right panel's three
tabs are the three things that are not the issue itself, and it opens on Pool
because that is the one you use while editing.

---

## Design

### 1. One store, and it is Supabase

This is still the argument, and `d1d7d6c` has made it sharper rather than
settling it. Reading is now behind one interface. **Writing is not**, and
writing is where the divergence happens:

| Writer | Writes to | Polls Raindrop |
|---|---|---|
| `scripts/press-run.ts` | `.press/` only | yes |
| `worker/index.ts` | Postgres only | yes |
| `/press` edit routes | whichever `review.ts` picked | — |
| `scripts/press-import.ts` | disk → Postgres, one way, by hand | — |

Two pollers consuming the same `hw` collection into two stores that only ever
reconcile when you remember to run the import by hand. Reorder issue 1 on your
laptop and it changes on disk; reorder it from the deployed page and it changes
in Postgres; the next import overwrites the second with the first. Nothing
warns you. This is the failure the original §1 predicted, and it is now real
rather than hypothetical.

So: `.press/` retires as a *store*. `src/app/press/*` and the API routes read
and write through `src/lib/press/db.ts` unconditionally.

- `remote.ts` is promoted — its functions move into `db.ts` and lose the
  `remote` prefix, because there is no longer a second kind.
- `review.ts` loses `reviewSource()` and `PRESS_SOURCE` and becomes the plain
  reader that assembles a page's worth of data from `db.ts`.
- `local.ts` and `issues.ts` are deleted. Their tests are rewritten against the
  db helpers. `formatBytes` and `pressUiEnabled` move somewhere that is not
  about the filesystem.
- `press-run.ts` is repointed at `db.ts`. It stays useful — it is the "poll and
  extract now" command, and the only one that can render, because rendering is
  minutes of headless Chromium that a Vercel function will never do.
- `.press/` stays on disk, untouched and unread, as the thing to fall back to
  if the import turns out to have been lossy. It is deleted in a later commit,
  not this one.

**Why this over keeping both:** ordering, order status, settings and the future
sharing all need durable rows that two processes can write. `d1d7d6c`'s own
commit message gives the reason the local path cannot simply be the answer —
"a deployed function has no disk" — and the same sentence read the other way is
the reason the disk cannot be: a laptop has no worker. Neither is a superset.
Only the database is, and it is the one both processes already reach.

The counter-argument, which is real: the local path is what has actually
printed a magazine, and Supabase-only means no press without network. It is
worth saying plainly that this trades offline for coherence.

### 2. The pool is the source of truth

`worker/index.ts::assignToOpenIssue` moves every `laid_out` item into whatever
issue is open, so the pool is empty by construction. That step is removed.
Items stay `laid_out` with `issue_id IS NULL` — that *is* the pool — until you
put them somewhere.

- **Pool** = `state = 'laid_out' AND issue_id IS NULL`
- **In an issue** = `state = 'in_issue' AND issue_id = …`, ordered by `position`
- **Removing from an issue** = `issue_id → NULL`, `state → 'laid_out'`,
  `position → NULL`. It is back in the pool, and nothing was destroyed.
- **Printed** = `state = 'printed'`, still pointing at its issue.

`remotePendingItems()` already reads exactly the pool query, so this half is
built.

The pool panel also has filters for the two piles that are not waiting:
`failed` (3 today, with the reason) and `skipped` (1 — reference pages), each
with a one-click retry / un-skip. `ITEM_TRANSITIONS` in `types.ts` already
allows both moves (`failed → queued`, `skipped → laid_out`); nothing enforces
them yet.

### 3. Many drafts, and "locked" is a state you can already claim

Removing the one-open-issue invariant is a two-line migration — drop
`press_issues_single_open` — plus repointing the two functions that assume it.
The state names in schema 009 already fit what you asked for:

| Schema state | What it means here | UI label |
|---|---|---|
| `open` | editable; drag things in and out | **Draft** |
| `closed` | contents fixed, built, ready to print | **Locked** |
| `approved` / `ordered` | claimed by a Lulu job | **Ordered** |
| `shipped` | done | **Shipped** |
| `rejected` | Lulu refused the files | **Rejected** |

"You cannot print an unlocked issue" is enforced in Postgres rather than in the
UI: `press_place_order` refuses any issue that is not `closed`, `rejected`, or
already printed once.

- **Lock** = compose the final PDFs, name the issue, then `press_close_issue`.
  One button, because a lock that leaves stale PDFs behind is a trap. The
  compose has to happen where there is a browser, which is the constraint the
  whole locking flow has to be designed around — see §9.
- **Unlock** is allowed only while `lulu_job_id IS NULL`, and returns the issue
  to `open`. After an order exists there is no unlock — that is the point.
- **New issue** is a button. `press_bootstrap_issue` becomes `press_new_issue`
  (allocate `MAX(number) + 1`, insert `open`) and `press_close_issue` stops
  auto-opening a successor, since nothing needs one to land in any more.

### 4. Deleting from the pool

The `×` on a pool row: **a confirm dialog**, then the item's raindrop moves out
of `hw` into a `Not printing` collection (the same `moveRaindrops` call
`archive.ts` already uses), and the row goes to a new `dropped` state. The
`url_key` unique index means a re-save of the same link will not resurrect it —
deletion sticks, which is what "permanent" has to mean, and the raindrop is
still sitting in `Not printing` if you change your mind.

Delete is refused for anything in an issue: remove it from the issue first, and
the pool row it lands in is deletable. No delete affordance exists in the middle
panel at all.

### 5. Settings live in a row, with env as the fallback

A single-row `press_settings` table holds the shipping address, the contact
email, the page threshold, copies-per-order, the Lulu package id and the
sandbox switch. Secrets (`LULU_CLIENT_SECRET`, `RAINDROP_TOKEN`,
`SUPABASE_SERVICE_ROLE_KEY`) stay env-only — those are not things a form should
ever hold.

One wrinkle the original plan did not account for: **`loadSettings()` is
synchronous** and is called from about twenty places, including module-level
initialisation in `db.ts` and `lulu.ts`. It cannot "grow a database read". So:

- `loadSettings()` stays exactly as it is — the env layer, sync, the floor.
- `loadEffectiveSettings(db)` is new and async: it reads the `press_settings`
  row and overlays every non-null column onto `loadSettings()`.
- Only the call sites that can await — the order flow, the settings form, the
  worker's tick — use the async one. Everything else keeps the env values,
  which is what it has today.

The settings tab is a plain form:

- **Ship to** — name, street, city, state, postcode, country, phone. Saved as a
  unit, because `shippingFromEnv()` already treats a partial address as no
  address and the form should be honest about that.
- **Email on file** — the address the approval email goes to and the order
  confirms against.
- **Payment** — not a form. A line of text saying Lulu bills the card on your
  Lulu account, and a link straight to Lulu's payment settings. No card number
  ever enters this app, which is the whole reason to link out.
- **Print settings** — package id, copies, page threshold, and a **Sandbox /
  Live** switch that defaults to sandbox — but which is explicitly *not* what
  stops a charge, and says so. The Lulu credentials on file are production
  credentials and Lulu's sandbox host 401s against them, so a "safe" sandbox
  order fails rather than costing nothing (`08ff4e8`). The actual guard is
  `PRESS_ORDER_ENABLED=1`, which lives in the environment precisely so it
  cannot be flipped from the screen that presses the button.

An incomplete address disables the Order button with the reason shown, rather
than failing at Lulu after you have pressed it.

### 6. Ordering

```
[Order]  →  ┌ Order Issue 1 ─────────────────────────┐
            │ Moral Seriousness and Doubt · 106pp    │
            │ 1 copy · $8.51 + $4.99 shipping        │  ← live quote()
            │ Ship to  V · 123 … · San Francisco     │
            │ Approve at  vaidehi@…                  │  ← the email on file
            │ ⚠ SANDBOX — no money will be spent     │
            │              Cancel   Send approval →  │
            └────────────────────────────────────────┘
                              ↓
              📧 "Issue 1 is ready — 106pp, $8.51"
                 [ Approve and print ]     ← GET renders, POST orders
                              ↓
              Lulu job created · raindrops archived to
              "2026-08-31 — Moral Seriousness and Doubt"
```

The dialog is where you catch a wrong address or a stale email; the email link
is the thing that actually spends money. Both halves exist —
`issueActionTokens`, `sendApprovalEmail`, `performApproval` and the
`/press/confirm/[token]` page are all written and tested. What is missing is the
button that starts it and the quote in the dialog. `lulu.ts::quote()` is
already written and returns print, shipping and total separately, which is
exactly the three numbers the dialog shows.

The order is refused, with the reason, when: the issue is not locked, the page
count is under Lulu's 32-page floor (`PRINT_SPEC.minPages`), the address is
incomplete, or an unfinished order already exists for it.

### 7. Orders

A new `press_orders` table rather than reading `lulu_job_id` off the issue.
Today an issue has at most one order and the columns would do; the moment
someone else can order a copy of issue 3, orders are many-per-issue with
different addresses and different payers. Introducing the table now costs one
migration and saves reshaping the panel later.

```sql
press_orders (
  id, issue_id, lulu_job_id, idempotency_key, status, line_item_status,
  quantity, cost_cents, currency, tracking_urls jsonb,
  ship_to jsonb,        -- snapshotted: the address at order time, not now
  ordered_by,           -- your email today; someone else's later
  placed_at, shipped_at, updated_at
)
```

The panel lists them newest first: issue name and number, status
(`CREATED → UNPAID → PAYMENT_IN_PROGRESS → PRODUCTION_DELAYED → IN_PRODUCTION →
SHIPPED`), cost, and tracking links once Lulu supplies them. Refresh is both a
button and a background pass — `lulu.getPrintJob` per unfinished order — so the
panel is right whether or not the worker is up.

**Order another copy.** A shipped issue gets the button too. This is the reason
`press_claim_order` had to go: it kept the claim in `press_issues.lulu_job_id`,
so an issue could be ordered exactly once, forever. `press_place_order`
replaces it and reads the issue's state to decide what kind of order this is —
a locked issue is the print run and advances to `approved` in the same
statement; an already-shipped one is just another copy and leaves the issue's
state machine alone. Idempotency moves to `press_orders.idempotency_key`, where
it belongs, and a retry after a timeout finds the first attempt's row instead of
buying a second copy.

`performApproval` in `order.ts` is rewritten against it: it takes an order row
rather than deriving everything from the issue, and writes the Lulu job id,
cost and status back to that row.

### 8. What the worker still does

Its job narrows to the parts that must happen without you: poll Raindrop,
extract, measure-render, refresh order status, and follow ordered issues to
shipped and archived. It stops closing issues, stops composing on a schedule and
stops emailing approvals on a timer, because you now decide when an issue is
finished. The weekly digest stays — a summary of what arrived and what failed
is worth having whether or not anything printed.

**This is the real behavioural change in the plan** and it deserves saying
plainly: press stops being an autonomous loop that mails you a magazine every
few weeks, and becomes a tool you sit down at. The page threshold survives as a
guide rail (the progress bar, and an **Auto-fill from pool** button that applies
the old oldest-first-to-100-pages rule in one click), not as a trigger.

### 9. Where the rendering happens — decided

Lock composes the final PDFs, and rendering is minutes of headless Chromium
that a Vercel function cannot do — `remote.ts` says so itself, and `/rebuild`
already answers 501 when it finds itself deployed.

**Built: option 2, locking works where there is a browser.** `POST
/api/press/issue/N/lock` composes and only then calls `press_close_issue`, so a
render that fails leaves the issue a draft rather than freezing its contents
against PDFs that do not match them. Deployed, it answers 501 and says to lock
from the machine that can build.

The two-step (a `compose_requested_at` column the worker picks up) was designed
and not built. It is the right answer the day `/press` is somewhere you use
without your laptop, and nothing here forecloses it — but it turns one click
into a wait of up to a poll interval, and it would have been the *only*
untested path in the ordering flow, since locking is what produces the files
Lulu is sent. Building the honest 501 first means the flow that spends money
has been exercised end to end before the asynchronous version of it exists.

The consequence to be clear about: **the workbench is fully usable only where
`press-run` can render.** Deployed it is read, reorder, order and settings —
everything except lock and rebuild.

## Schema: migration 013

`supabase/migrations/013_press_workbench.sql` is **written and committed** —
it was swept into `d1d7d6c` unintentionally — and **not applied**.

```sql
DROP INDEX IF EXISTS press_issues_single_open;          -- many drafts

ALTER TABLE press_items ... CHECK (state IN (..., 'skipped', 'dropped'));

CREATE TABLE press_settings (…);   -- single row, id BOOLEAN PRIMARY KEY
CREATE TABLE press_orders   (…);   -- as §7
-- RLS on, no policies, service-role only — same as every other press table.

CREATE FUNCTION press_new_issue()      …  -- replaces press_bootstrap_issue
CREATE FUNCTION press_reopen_issue(…)  …  -- unlock, while unordered
CREATE FUNCTION press_set_issue_order(…)  -- a whole running order, deferred
CREATE FUNCTION press_drop_item(…)     …  -- pool delete, refuses in_issue
CREATE FUNCTION press_place_order(…)   …  -- replaces press_claim_order
DROP FUNCTION press_bootstrap_issue, press_claim_order;
```

Two corrections it carries over `2026-08-31-003-schema-draft.sql`, both found
by diffing the draft against the live database:

- **The draft's new state check dropped `'skipped'`.** Migration 011 had just
  added it, there is a skipped item in the table, and §2 above asks for an
  un-skip button. Applying the draft as written would have failed on the
  existing row. 013 keeps `'skipped'` and adds `'dropped'` beside it.
- **`press_claim_order` cannot express a second order** — see §7.

And one the draft got right that is worth not losing: `setIssueOrder` in
`db.ts` loops one `UPDATE` per row, so moving an article from position 2 to
position 0 collides with whatever holds 0 under a non-deferrable unique index.
It has never failed because it has never run against a real database with more
than one issue. 013 makes the constraint `DEFERRABLE` and moves the reorder
into `press_set_issue_order`, because PostgREST gives no way to hold a
transaction open across requests.

### Applying it

`press_bootstrap_issue` is **not dropped — it is made to raise**, which is a
deliberate change from the draft and worth the sentence.

Dropping it breaks a stale worker with "function does not exist", which is an
obscure way to learn you forgot to redeploy. Leaving it working would be far
worse: `assignToOpenIssue` would go on sweeping every `laid_out` item into
whichever issue is open — precisely what §2 exists to stop — and would do it
silently. Raising splits the difference. A worker running pre-workbench code
fails on its first call, at boot, before it can touch anything, and says why.
**A crashed worker moves no articles.**

That inverts the sequencing risk. On the schema as it stands *today*, the
deployed worker sweeps the pool into the open issue every thirty minutes — 17
pool items and issue 1 `open` is exactly the shape that sweep consumes.
Applying 013 stops that. So it is protective, and the order is:

    npm run db:apply -- 013_press_workbench.sql     # stops the sweep
    fly deploy -c worker/fly.toml                   # then the new worker runs

The worker in this branch no longer calls `press_bootstrap_issue` at all, so
once deployed the raise is unreachable and is simply a tombstone for the next
person who wonders where the function went.

---

## Build order

Each phase leaves the app usable.

**1 · One store.** *Partly done by `d1d7d6c`; not finished* — migrations 010–012, the
import (run: 33 items, issue 1), and a Supabase reader all exist. What is left
is the half that commit deliberately did not do: fold `remote.ts` into `db.ts`,
drop `reviewSource()` / `PRESS_SOURCE`, repoint `press-run.ts` at the database,
delete `local.ts` and `issues.ts`, rewrite their tests. Worker changes from §2
and §8, then deploy, then apply 013.
*Usable:* exactly what works today, on one store. Nothing visible changes,
which is how you know the import was clean.

**2 · The three-panel shell.** *Built.* Issues rail with search and
state filters, the middle panel bound to the selected issue, the right panel
with its three tabs. One `DndContext` spans the issue and the pool, so dragging
in either direction is one gesture and one call — `POST
/api/press/issue/N/contents` states the complete running order, because a
single drag can add, reorder and displace at once and three requests would tear
if the second failed.

**3 · Drafts and locking.** *Built.* `POST /api/press/issue` opens a draft and
several may be open at once; Lock composes then freezes; Unlock is refused once
a Lulu job exists; Auto-fill applies the old oldest-first-to-the-threshold rule
as a button. Locked issues render read-only.

**4 · Pool deletion.** *Built.* A confirm dialog, `press_drop_item` (which
Postgres refuses for anything an issue holds), the raindrop moved to a
`Not printing` collection, and a `dropped` filter. Retry and un-skip are on the
`failed` and `skipped` piles beside it.

**5 · Settings.** *Built.* The form, `loadEffectiveSettings` layering the row
over the environment, the Lulu payment link-out, an unmissable Sandbox/Live
pair, and the address saved as a unit.

**6 · Ordering and orders.** *Built, not exercised.* The quote in the dialog,
every blocker listed rather than a dead button, the approval email, the
`press_orders` panel with refresh, and "Order another copy" on a shipped issue.
**No order has been placed** — see "What is not verified".

### What is not verified

Everything above type-checks, builds, lints and passes 668 tests, and the
worker and library layers are exercised by unit tests including the two new
reorder cases. But:

- **Migration 013 has not been applied.** Every route that touches
  `press_settings`, `press_orders`, `press_new_issue`, `press_set_issue_order`,
  `press_reopen_issue` or `press_drop_item` will fail until it is. The pool,
  the rail and the middle panel work without it; the Orders tab says so in
  place of a list.
- **Nothing has been run against the real database**, so the workbench has
  never rendered with live data.
- **No order, sandbox or otherwise, has been placed.** A real sandbox order end
  to end is still the gate before the Live switch is ever touched.

---

## Scope boundaries

**In scope:** everything above, plus "Order another copy" (was question 5).

**Out of scope, deliberately:** editing an article's text or fixing a bad
extraction from here (still: re-save the link); cover art beyond the generated
one; per-article page-break control; changing an ordered issue in any way;
mobile layout; a **Suggest an issue** button (was question 6 — sort and search
only); a per-order shipping address (was question 8 — settings holds one
address, and `press_orders.ship_to` snapshots it).

**Not built now, but designed around:** other people ordering copies. The seams
are `press_orders.ordered_by`, the snapshotted `ship_to`, and orders being
many-per-issue. Two things will need answering before it is built, and both are
worth knowing now: your Lulu account's card cannot be charged for someone
else's copy, so it needs either Lulu's own storefront or payment collected up
front; and printing copies of other people's writing for other people is
redistribution in a way that printing one for yourself is not.

---

## Decided

Answered before the first draft: Supabase over files; confirm dialog *and*
emailed approval link; several drafts at once; pool delete also archives the
raindrop.

Answered since, and folded in above:

1. **Does anything still run on its own?** No — `press-worker` was never
   deployed, so nothing ever has. See "Nothing has ever run on its own". The
   worker code is narrowed as §8 describes and is ready to deploy if you ever
   want it; whether it is worth an always-on machine is now an open question
   rather than an assumption.
2. **Where does this live?** *Decided: no password for now.*
   `src/middleware.ts` implements one and the matcher covers every workbench
   route, but `PRESS_PASSWORD` is deliberately left unset, and that file treats
   unset as open. `PRESS_UI_ENABLED` still keeps it off production.

   The consequence is worth stating because it constrains a design decision
   rather than just carrying risk: **the guard on spending money cannot live on
   the page.** Anyone who reaches `/press` can press any button on it, so
   `PRESS_ORDER_ENABLED` is an environment variable and the Sandbox/Live
   control in Settings is explicitly labelled as not being a safety net. If a
   password is ever set, that stays true anyway — a form is the wrong place for
   the last guard against a charge — but until then it is the *only* thing
   that is true.
4. **How many copies?** One, from `press_settings.copies`, changeable in the
   settings form. The Lulu plumbing is identical for 1 or 5.
5. **Can you order a past issue again?** Yes — §7. This is what forced
   `press_claim_order` to be replaced.
6. **What should the pool do when it gets big?** Search and sort. No
   Haiku-grouped **Suggest an issue** in this pass.
7. **Undo?** A confirm dialog, not an undo toast. The raindrop survives in
   `Not printing` either way, so the confirm is not the only protection.
8. **A separate ship-to per order?** Not now. `press_orders.ship_to` snapshots
   the settings address, which is the seam for it later.

## Still open

3. **Should the issue name still be regenerated on every rebuild?** It is one
   Haiku call, and reordering issue 1 once renamed it from "Doing Good
   Seriously" to "Doing Good Right". My suggestion stands: name freely while a
   draft is moving, let you overwrite it by hand, and freeze it at lock.

9. **Anything for a rejected issue?** Lulu can refuse files after approval.
   Today it lands in `rejected` with a reason and the weekly tick re-sends
   approval. With the tick no longer composing, the rail needs to show it and
   the middle panel needs a "fix and re-lock" path. `press_reopen_issue` in 013
   already accepts `rejected`, so the database half is done; the UI half is not
   designed.

10. **Does `.press/` stay readable?** §1 retires it as a store and leaves the
    directory on disk. Deleting it is a separate, later commit — but "later"
    should have a trigger, and the honest one is "after an issue has been
    ordered end to end from the database". Worth agreeing now, because until
    then every bug in the new path has a tempting escape hatch that quietly
    re-forks the state.

11. **Offline.** One store means no press without network. It has never
    mattered, but it has also never been true before, and §1 is the moment it
    stops being true.
