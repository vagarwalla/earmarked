# press — runbook

The pipeline that turns saved reading into a printed magazine. Plan:
[docs/plans/2026-08-27-001-feat-press-magazine-pipeline-plan.md](plans/2026-08-27-001-feat-press-magazine-pipeline-plan.md).

Two runtimes share one repo and one database:

| | Runs | Does |
|---|---|---|
| **Vercel** (existing earmarked deploy) | `src/app/api/press/*`, `src/app/press/*` | inbound email webhook, approval confirmation pages |
| **Fly** (`worker/`) | always-on machine | Raindrop polling, extraction, layout, compose, ordering, weekly tick |

State is the existing Supabase Postgres. PDFs and images are in the `press`
Storage bucket. The worker holds nothing on disk, so it can be killed at any
moment and restarted.

---

## Configuration

**This repo is public. Nothing below belongs in a file in it.** `.env*` is
gitignored, which is why this table exists rather than a `.env.example`. Set
these in Vercel, in `fly secrets`, and in a local `.env.local`.

### Required everywhere

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (already set for earmarked) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Service role** key. press tables have RLS on with no policies, so the anon key cannot read them at all — this is the only way in, and it must never reach the browser. |
| `PRESS_STORAGE_BUCKET` | Defaults to `press` |

### Ingestion (worker)

| Variable | What it is |
|---|---|
| `RAINDROP_TOKEN` | Raindrop API token |
| `RAINDROP_COLLECTION_ID` | Numeric id of the `hw` / `homework` collection — resolve it once with `resolveHomeworkCollection()` (see below) |

### Email in (Vercel + the Cloudflare worker)

| Variable | What it is |
|---|---|
| `PRESS_EMAIL_WEBHOOK_SECRET` | Shared secret, `openssl rand -hex 32`. Must match the Cloudflare worker's copy. **The route returns 503 while this is unset** — it will not run open. |
| `PRESS_NEWSLETTER_ALLOWLIST` | Comma-separated sender addresses whose newsletters get printed. Curated by hand — subscribing to something is not the same as wanting it printed (KTD4), and a blanket filter would let subscription volume set the print cadence and the spend. |

### Mail out (worker)

| Variable | What it is |
|---|---|
| `RESEND_API_KEY` | Resend key |
| `PRESS_MAIL_FROM` | Sender on a verified domain |
| `PRESS_MAIL_TO` | Where approval emails, the weekly digest, and the relayed Gmail verification code go |

### Printing (worker)

| Variable | What it is |
|---|---|
| `LULU_CLIENT_KEY` / `LULU_CLIENT_SECRET` | Lulu OAuth client credentials |
| `LULU_SANDBOX` | Defaults to sandbox. **Only `false` reaches production** — a misconfigured environment cannot spend money by accident. |
| `LULU_PACKAGE_ID` | Defaults to `0700X1000.FC.STD.PB.080CW444.GXX` (7×10, perfect bound, 80# coated, standard colour, glossy cover) |
| `PRESS_SHIP_NAME`, `PRESS_SHIP_STREET1`, `PRESS_SHIP_STREET2`, `PRESS_SHIP_CITY`, `PRESS_SHIP_STATE`, `PRESS_SHIP_POSTCODE`, `PRESS_SHIP_COUNTRY`, `PRESS_SHIP_PHONE` | Shipping address. A *partial* address is treated as no address — approval refuses with `not-configured` rather than failing later at Lulu. |

### Approval links (Vercel + worker)

| Variable | What it is |
|---|---|
| `PRESS_APP_URL` | Public origin of the app, e.g. `https://earmarked.vercel.app` — approval links are built from it |
| `PRESS_ACTION_TOKEN_SECRET` | Reserved for signing; tokens are currently random and stored hashed |

### Policy (optional)

| Variable | Default |
|---|---|
| `PRESS_PAGE_THRESHOLD` | `100` — an issue closes at or above this |
| `PRESS_MAX_ISSUE_AGE_WEEKS` | `8` — backstop so a slow month cannot stall the loop |
| `ANTHROPIC_API_KEY` | Optional. Names issues from their contents (KTD8); without it they are named `Issue N`. |

---

## First-time setup

1. **Migration.** `supabase/migrations/009_press_schema.sql` applies through the
   repo's existing runner (`src/lib/migrate.ts`) on server start when
   `SUPABASE_ACCESS_TOKEN` is set.
2. **Storage bucket.** Create a **private** bucket named `press`. Lulu is given
   time-limited signed URLs; the bucket itself must not be public.
3. **Resolve the `hw` collection id:**
   ```ts
   import { createRaindropClient } from '@/lib/press/raindrop'
   console.log(await createRaindropClient().resolveHomeworkCollection())
   ```
   Put the `_id` in `RAINDROP_COLLECTION_ID`.
4. **Email door.** See [infra/email-worker/README.md](../infra/email-worker/README.md).
   Gmail will not enable auto-forwarding until its confirmation code is
   confirmed; that mail lands in the pipeline and is relayed to `PRESS_MAIL_TO`
   rather than ingested.
5. **Deploy the worker:** `fly deploy -c worker/fly.toml`, then
   `fly secrets set ...` for everything above.
6. **Stay on the Lulu sandbox** until a sandbox order has gone through end to
   end. Only then set `LULU_SANDBOX=false`.

---

## How it runs

**Every 30 minutes:** poll `hw` → extract → measure-render each new article →
assign to the open issue.

**Sunday 19:00 PT:** close the open issue if it has filled (≥ threshold) or has
been open past the age backstop and still clears Lulu's 32-page floor; compose
it; quote it; email approval. Re-send approval for anything still waiting.
Follow ordered issues to shipped and archive them. Send the weekly digest.

**On approve:** one Lulu print job, then the articles move out of `hw` into a
Raindrop collection named `YYYY-MM-DD — <issue name>`.

### Invariants worth knowing

- **Exactly one issue is open**, enforced by a partial unique index. Closing an
  issue and opening its successor happen in one transaction.
- **An issue can be ordered once.** `press_claim_order` check-and-sets
  `lulu_job_id` in a single statement, so a timeout-then-retry or a double tap
  reports the existing job rather than placing a second order.
- **Approval links are GET-safe.** A GET only renders a confirmation page; the
  state change is a POST. Mail scanners prefetch links, and an acting GET would
  let Gmail place an order or burn a single-use token before it was ever read.
- **The renderer never resolves a network URL.** Extraction downloads and
  rewrites every image and strips all external references; Chromium then runs
  over content that arrived through a public email address.
- **Everything outbound goes through the SSRF guard** (`src/lib/press/fetch.ts`):
  http(s) only, DNS resolved and checked against private ranges, every redirect
  hop re-checked.

---

## When something goes wrong

**An article did not make it in.** Check the weekly digest — every `failed` item
appears with its reason. Re-saving the link to `hw` re-queues it. Reader-dropped
articles are excluded from the digest on purpose.

**An issue will not compose.** `press_events` has an `issue_composed` row with
the preflight problems. `composeIssue` fails an item it cannot read rather than
printing blank pages, so a stuck issue usually means the storage object is
missing.

**Lulu rejected the files after approval.** The issue goes to `rejected` with
the reason. Fix the cause, and the next weekly tick re-composes and re-sends
approval — `rejected → approved` is a supported transition.

**An order looks stuck at `pending`.** That is a held claim: the claim succeeded
but the Lulu call did not return. The claim is deliberately *not* released,
because releasing it is the only way to risk a double order. Check `press_events`
for `order_failed`, confirm at Lulu whether a job exists, and set
`lulu_job_id` by hand.

**The weekly tick did not fire.** The scheduler runs in-process, so the machine
must be up. Confirm `auto_stop_machines = false` and `min_machines_running = 1`
are still in effect — Fly's defaults would suspend an idle machine and the tick
would silently never run.

**Renders are slow or the machine is out of memory.** Chromium on a 100-page
interior is the heavy step. Raise `memory` in `worker/fly.toml`; the weekly
cadence tolerates minutes.

---

## Local development

```
npm test                          # the whole suite
npx vitest run src/lib/press      # press only
npx tsx scripts/press-preview.ts  # render a sample article to look at
```

`scripts/press-preview.ts` writes HTML plus a PDF when a browser is reachable
(set `PRESS_CHROMIUM_PATH` if it is not found). Typography bugs do not show up
in unit tests — look at the PDF.
