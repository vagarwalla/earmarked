---
title: "feat: press workbench — issues, pool, orders and settings on one screen"
date: 2026-08-31
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

## Where things stand

| | Today |
|---|---|
| What `/press` reads | `.press/state.json` and `.press/issue-N/` on disk |
| What fills it | `scripts/press-run.ts`, run by hand |
| Editing | Reorder / add / remove / rebuild, open issue only (plan 002) |
| Ordering | Manual: download both PDFs, upload at lulu.com, run `--printed` |
| Settings | Environment variables only (`PRESS_SHIP_*`, `PRESS_MAIL_TO`, …) |
| Order history | Nowhere |
| The other implementation | Supabase schema 009/010 + `worker/` on Fly, with `lulu.ts`, `order.ts`, `approval.ts` and `archive.ts` already written against it |

The ordering code you want a button for already exists — it just talks to a
database the UI does not read. That is the gap this plan closes.

Local state as it stands: 33 items (29 waiting, 3 failed, 1 skipped), issue 1
drafted with 12 of them and built to 104 pages, nothing printed.

---

## The shape

```
┌────────────────┬─────────────────────────────────┬──────────────────────────┐
│ ISSUES         │  Moral Seriousness and Doubt    │ POOL · ORDERS · SETTINGS │
│ ┌────────────┐ │  Issue 1 · draft · 104pp        │                          │
│ │ search…    │ │  ─────────────────────────────  │ 29 waiting  [search…]    │
│ └────────────┘ │  [Rebuild] [Lock] [Order]       │ ┌──────────────────────┐ │
│ all draft      │                                 │ │⠿ On sincerity     30p│ │
│ locked printed │  ⠿ 1  On sincerity          30p │ │  joecarlsmith.com  ×│ │
│                │  ⠿ 2  EA is about maximiz…   5p │ ├──────────────────────┤ │
│▸ #3  draft  12p│  ⠿ 3  Deference and moral…  14p │ │⠿ Moral error and…  9p│ │
│  #2  draft  47p│  ⠿ 4  …                         │ │  forum.effective…  ×│ │
│🔒 #1 locked 104│                                 │ ├──────────────────────┤ │
│  ✔ #0 shipped  │  104 / 100 pages ── ready       │ │⠿ …                   │ │
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

`.press/` retires. `src/app/press/*` and the API routes read and write through
`src/lib/press/db.ts` — the same functions `order.ts` and the worker already
use. `local.ts` and `issues.ts` (the file-lock, the JSON state) go away once the
import has run.

A one-shot `scripts/press-import.ts` moves what exists: each item in
`state.json` becomes a `press_items` row (`raindrop_id`, `url_key`, `state`,
`page_count` carry straight over), each `.press/items/<id>/article.json`
uploads to the `press` bucket, issue 1's draft becomes a `press_issues` row with
`position` set from the array index, and `interior.pdf` / `cover.pdf` upload to
`storagePath.interior(issue.id)` / `.cover(issue.id)`. It is idempotent on
`url_key` so a half-finished import can be re-run.

`scripts/press-run.ts` stays useful — repointed at `db.ts`, it is the
"poll and extract now" command whether or not the Fly worker is running.

**Why this over keeping the files:** ordering, order status, settings and the
future sharing all need durable rows that two processes can write. The schema
for that is already written, migrated and tested. Two implementations of the
same pipeline is the actual problem here, and this deletes one.

### 2. The pool is the source of truth

Today `worker/index.ts::assignToOpenIssue` moves every `laid_out` item into
whatever issue is open, so the pool is empty by construction. That step is
removed. Items stay `laid_out` with `issue_id IS NULL` — that *is* the pool —
until you put them somewhere.

- **Pool** = `state = 'laid_out' AND issue_id IS NULL`
- **In an issue** = `state = 'in_issue' AND issue_id = …`, ordered by `position`
- **Removing from an issue** = `issue_id → NULL`, `state → 'laid_out'`,
  `position → NULL`. It is back in the pool, and nothing was destroyed.
- **Printed** = `state = 'printed'`, still pointing at its issue.

The pool panel also has filters for the two piles that are not waiting:
`failed` (3 today, with the reason) and `skipped` (reference pages), each with a
one-click retry / un-skip, because right now un-skipping means hand-editing
JSON.

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

The useful accident: `press_claim_order` already refuses to claim anything that
is not `closed` or `rejected`, so "you cannot print an unlocked issue" is
enforced in Postgres, in one statement, without new code.

- **Lock** = compose the final PDFs, name the issue, then `press_close_issue`.
  One button, because a lock that leaves stale PDFs behind is a trap.
- **Unlock** is allowed only while `lulu_job_id IS NULL`, and returns the issue
  to `open`. After an order exists there is no unlock — that is the point.
- **New issue** is a button. `press_bootstrap_issue` becomes `press_new_issue`
  (allocate `MAX(number) + 1`, insert `open`) and `press_close_issue` stops
  auto-opening a successor, since nothing needs one to land in any more.

### 4. Deleting from the pool

The `×` on a pool row: a confirm, then the item's raindrop moves out of `hw`
into a `Not printing` collection (the same `moveRaindrops` call `archive.ts`
already uses), and the row goes to a new `dropped` state. The `url_key` unique
index means a re-save of the same link will not resurrect it — deletion sticks,
which is what "permanent" has to mean, and the raindrop is still sitting in
`Not printing` if you change your mind.

Delete is refused for anything in an issue: remove it from the issue first, and
the pool row it lands in is deletable. No delete affordance exists in the middle
panel at all.

### 5. Settings live in a row, with env as the fallback

A single-row `press_settings` table holds the shipping address, the contact
email, the page threshold, copies-per-order, the Lulu package id and the
sandbox switch. `loadSettings()` grows a database read layered over the existing
env read, so nothing that runs today breaks and secrets (`LULU_CLIENT_SECRET`,
`RAINDROP_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`) stay env-only — those are not
things a form should ever hold.

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
  Live** switch that is unmissable and defaults to sandbox.

An incomplete address disables the Order button with the reason shown, rather
than failing at Lulu after you have pressed it.

### 6. Ordering

```
[Order]  →  ┌ Order Issue 1 ─────────────────────────┐
            │ Moral Seriousness and Doubt · 104pp    │
            │ 1 copy · $8.51 + $4.99 shipping        │  ← live quote()
            │ Ship to  V · 123 … · San Francisco     │
            │ Approve at  vaidehi@…                  │  ← the email on file
            │ ⚠ SANDBOX — no money will be spent     │
            │              Cancel   Send approval →  │
            └────────────────────────────────────────┘
                              ↓
              📧 "Issue 1 is ready — 104pp, $8.51"
                 [ Approve and print ]     ← GET renders, POST orders
                              ↓
                 Lulu job created · raindrops archived to
                 "2026-08-31 — Moral Seriousness and Doubt"
```

The dialog is where you catch a wrong address or a stale email; the email link
is the thing that actually spends money. Both halves exist —
`issueActionTokens`, `sendApprovalEmail`, `performApproval` and the
`/press/confirm/[token]` page are all written and tested. What is missing is the
button that starts it and the quote in the dialog.

The order is refused, with the reason, when: the issue is not locked, the page
count is under Lulu's 32-page floor, the address is incomplete, or a
`lulu_job_id` already exists. That last one is `press_claim_order` doing its job
— an issue can be ordered exactly once, and a double tap reports the existing
job rather than buying a second copy.

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

---

## Schema: migration 011

```sql
-- Many drafts at once.
DROP INDEX IF EXISTS press_issues_single_open;

-- The pool needs a terminal state that is not a failure.
ALTER TABLE press_items DROP CONSTRAINT press_items_state_check;
ALTER TABLE press_items ADD CONSTRAINT press_items_state_check
  CHECK (state IN ('queued','extracted','laid_out','in_issue','printed','failed','dropped'));

CREATE TABLE press_settings (…);   -- single row, id BOOLEAN PRIMARY KEY DEFAULT TRUE
CREATE TABLE press_orders   (…);   -- as above
-- RLS on, no policies, service-role only — same as every other press table.

CREATE OR REPLACE FUNCTION press_new_issue() …      -- replaces press_bootstrap_issue
CREATE OR REPLACE FUNCTION press_close_issue(…) …   -- no longer opens a successor
CREATE OR REPLACE FUNCTION press_drop_item(…) …     -- pool delete, refuses in_issue
```

---

## Build order

Each phase leaves the app usable, and phase 1 is the one that unblocks the rest.

**1 · Move to Supabase.** Migration 011, `press-import.ts`, `/press` and the
existing edit routes repointed at `db.ts`, `press-run.ts` repointed too.
`local.ts` / `issues.ts` deleted, their tests rewritten against the db helpers.
*Usable:* exactly what works today, on the new store. Nothing visible changes,
which is how you know the import was clean.

**2 · The three-panel shell.** Issues rail (search, state filters, newest
first), the middle panel bound to the selected issue, the right panel with its
three tabs. Pool tab shows the pool with drag into the issue, remove back out,
and the `failed` / `skipped` filters.
*Usable:* the whole editing experience you asked for, minus deletion.

**3 · Drafts and locking.** New issue, several drafts, lock (compose + freeze),
unlock while unordered, auto-fill from pool. Locked issues render read-only.
*Usable:* you can curate a backlog into three themed issues and freeze one.

**4 · Pool deletion.** Confirm, drop the row, move the raindrop to
`Not printing`, and a `dropped` filter to see what you have discarded.

**5 · Settings.** The form, the db-over-env settings layer, the Lulu payment
link-out, the sandbox switch and the "why Order is disabled" line.

**6 · Ordering and orders.** Quote in the dialog, the confirm, the approval
email, `press_orders`, the orders panel and status refresh. Ship a real sandbox
order end to end before the live switch is ever touched.

---

## Scope boundaries

**In scope:** everything above.

**Out of scope, deliberately:** editing an article's text or fixing a bad
extraction from here (still: re-save the link); cover art beyond the generated
one; per-article page-break control; changing an ordered issue in any way;
reprinting a past issue; mobile layout.

**Not built now, but designed around:** other people ordering copies. The seams
are `press_orders.ordered_by`, the snapshotted `ship_to`, and orders being
many-per-issue. Two things will need answering before it is built, and both are
worth knowing now: your Lulu account's card cannot be charged for someone
else's copy, so it needs either Lulu's own storefront or payment collected up
front; and printing copies of other people's writing for other people is
redistribution in a way that printing one for yourself is not.

---

## Questions

Answered before writing this: Supabase over files; confirm dialog *and* emailed
approval link; several drafts at once; pool delete also archives the raindrop.
These are the ones left.

1. **Does anything still run on its own?** Is the Fly worker deployed and
   polling today, or has `press-run.ts` on your laptop been the only thing that
   has ever run? It changes whether phase 1 ends with a deploy or with a
   `npm run` you type. If nothing is running, a **Sync from Raindrop** button in
   the pool panel is probably the honest answer, at least at first.

2. **Where does this live — localhost, or a URL?** `/press` is off in
   production on purpose (`pressUiEnabled`), because it lists your reading. If
   "show people" means screen-sharing, nothing changes. If it means sending
   someone a link, it needs auth in front of it before phase 2, and that is a
   real piece of work rather than a checkbox.

3. **Should the issue name still be regenerated on every rebuild?** It is one
   Haiku call today, and reordering issue 1 once renamed it from "Doing Good
   Seriously" to "Doing Good Right". My suggestion: name freely while a draft is
   moving, let you overwrite it by hand, and freeze it at lock.

4. **How many copies?** Lulu line items take a quantity and the plumbing is
   identical for 1 or 5. Worth having before you print something you want to
   give away.

5. **Can you order a past issue again?** Plan 002 said no on purpose. With an
   orders panel it becomes the obvious thing to want — "Order another copy" on a
   shipped issue is a small addition, and it is the first half of sharing.

6. **What should the pool do when it gets big?** 29 now, but it only grows.
   Sort by newest / oldest / longest / shortest is easy; the more interesting
   version is a **Suggest an issue** button that asks Haiku to group the pool
   into a coherent 100 pages, since something very close to that already names
   issues.

7. **Undo?** Removing from an issue is already reversible. Deleting is not, and
   a confirm dialog is weaker protection than a toast with five seconds of
   undo — but the toast is more code. Which do you want?

8. **A separate ship-to per order?** Currently one address in settings. Needed
   eventually for sharing; possibly useful sooner if you want to send an issue
   to someone.

9. **Anything for a rejected issue?** Lulu can refuse files after approval.
   Today it lands in `rejected` with a reason and the weekly tick re-sends
   approval. With the tick no longer composing, the rail needs to show it and
   the middle panel needs a "fix and re-lock" path.
