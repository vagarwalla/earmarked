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

## Accounts

Since migration 018 press is multi-tenant. Every issue, article, order, job and
settings row carries an `owner_id`, issue numbers count within an account, and
the same URL saved by two people is two articles — before that it was one, and
the second person's copy vanished without a word.

Enforcement is the code, not RLS. Everything reaches these tables with the
service-role key, which RLS does not apply to, so the rule is kept by
`pressDb(owner)` in `src/lib/press/db.ts`: a client whose reads, updates and
deletes already carry `owner_id = <owner>` and whose inserts already set it.
Nothing has a default client, so getting hold of one means writing either
`pressDb(owner)` or `pressDbAsService()` — and there are exactly four places
the second is right, each named at its call site:

- the Fly worker, which runs the pipeline for everybody;
- `/api/press/action/[token]` and `/press/confirm/[token]`, where a signed
  single-use token is the authority and nobody is signed in;
- `/api/press/email-in`, authenticated by a shared secret;
- looking an account up, which cannot itself be scoped to the account.

RLS policies exist as a backstop and buy nothing today.

### Inviting somebody

Addresses are not in this repo — it is public, which is why 018 seeds the owner
with no email at all.

```bash
npm run press:invite -- --owner you@example.com     # the owner's own address
npm run press:invite -- alex@example.com alex "Alex Whitby"
npm run press:invite -- --list
```

An invitation is a row that can exist before the person has ever signed in;
their first magic link attaches their auth user to it. Nobody but the owner
gets `can_order` — ordering bills the one Lulu account on file.

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
| `LULU_PACKAGE_ID` | Defaults to `0700X1000.FC.STD.PB.060UW444.GXX` (7×10, perfect bound, 60# uncoated white, standard colour, glossy cover) |
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
classify it as a linkpost or not → assign to the open issue. A linkpost's
pointers are queued as articles of their own and extracted on the same tick.

**Sunday 19:00 PT:** close the open issue if it has filled (≥ threshold) or has
been open past the age backstop and still clears Lulu's 32-page floor; compose
it; quote it; email approval. Re-send approval for anything still waiting.
Follow ordered issues to shipped and archive them. Send the weekly digest.

**Every 10 seconds:** look for a compose the website has asked for, and run it.

**On approve:** one Lulu print job, then the articles move out of `hw` into a
Raindrop collection named `YYYY-MM-DD — <issue name>`.

### Where a render happens

Composing an issue is minutes of headless Chromium, so it happens wherever
there is a browser — and that is never a Vercel function.

| Where you press it | What happens |
|---|---|
| Locally, with `.press/` on disk | `buildIssue` runs inside the request and streams NDJSON progress. Unchanged; this is the fast loop |
| The deployed site | The route writes a `press_jobs` row and answers `202 {job}`. The worker claims it, renders, and writes progress back into the row; the button polls `/api/press/job/<id>` |

Both end the same way: `interior.pdf` and `cover.pdf` in Storage, `built_order`
and `page_total` on the issue, and — for a Lock — the issue frozen only after
the render succeeded.

One live job per issue, enforced by a partial unique index rather than by the
UI, so a second press of the button during a render is refused with a sentence
instead of starting a second Chromium. A job outlives the tab that asked for
it: reload, or open `/press` on another device, and the progress is still
there, because the workbench asks `/api/press/job` on load.

### Ordering several issues at once

Lulu charges shipping per *job*, not per book, so two issues sent as two jobs
pay for two deliveries of the same weight to the same door. Tick them in the
workbench rail instead and they go as one job: on live prices a 100pp and a
64pp issue are $27.60 apart and $22.41 together, and the $5.19 is the second
parcel.

The path is the same two deliberate acts as a single order, and the dialog
still spends nothing:

1. Tick two or more locked (or already shipped, for another copy) issues in the
   rail and press **Order these N**. `GET /api/press/order?issues=3,4` prices
   the job as it would be placed *and* each issue as the job it would have been
   alone, so the saving is shown as the comparison it is.
2. **Send approval** mails one link covering the whole bundle.
   `POST /api/press/order`. Still nothing ordered.
3. The link opens the confirmation page, which lists every issue in the parcel;
   its button POSTs to `/api/press/action/[token]`, which runs
   `performBundledApproval` over all of them.

Needs migrations `015_press_order_bundles.sql` (the job columns on
`press_orders`) and `016_press_bundle_tokens.sql` (`issue_ids` on
`press_action_tokens`). Until both are applied, approval fails with a missing
function or column and nothing is placed.

### Invariants worth knowing

- **Exactly one issue is open**, enforced by a partial unique index. Closing an
  issue and opening its successor happen in one transaction.
- **An issue can be ordered once.** `press_place_order` claims a `press_orders`
  row against an idempotency key in a single statement, so a timeout-then-retry
  or a double tap reports the existing order rather than placing a second one.
- **Several issues can share one Lulu job.** Lulu charges shipping per job, not
  per book, so bundling issues into one job pays for one parcel instead of two
  — $22.72 against $27.91 for issues 1 and 2 at live prices. A bundle is still
  one `press_orders` row per issue, tied together by `bundle_key` and numbered
  by `line_index`; `performBundledApproval` places it. It is all-or-nothing
  outbound (a job cannot be sent half-way, so one uncomposed issue refuses the
  whole bundle) and per-issue inbound (Lulu validates each interior separately,
  so a refused issue 4 leaves issue 3 printing on the next line of the job).
- **A bundle is approved by ONE link.** The token names every issue it covers
  (`press_action_tokens.issue_ids`), so the single-use property covers the
  parcel rather than each issue in it — N links would be N chances to buy half
  a parcel. Expiring a token matches that array, so a fresh approval for issue 4
  kills an outstanding bundle link that also carried issue 4: the two would
  carry different idempotency keys, and following both would buy issue 4 twice.
- **A bundle's outcome is never one verdict.** `/api/press/action/[token]`
  answers a bundle with 200 once the job exists — even where a line of it was
  refused — and puts the per-issue verdicts in the body. 409 is kept for the
  case it describes: nothing was sent. Reporting "it failed" over a book already
  in production is the failure worth designing against.
- **Approval links are GET-safe.** A GET only renders a confirmation page; the
  state change is a POST. Mail scanners prefetch links, and an acting GET would
  let Gmail place an order or burn a single-use token before it was ever read.
- **The renderer never resolves a network URL.** Extraction downloads and
  rewrites every image and strips all external references; Chromium then runs
  over content that arrived through a public email address.
- **Everything outbound goes through the SSRF guard** (`src/lib/press/fetch.ts`):
  http(s) only, DNS resolved and checked against private ranges, every redirect
  hop re-checked. Links harvested from a linkpost are no exception — they arrive
  from a saved page, which is untrusted input.
- **A linkpost's pieces print directly behind it**, and an issue never holds one
  without the other. The invariant is imposed on write (`orderWithLinkposts`)
  rather than defended in the editor, so it holds however the order arrived —
  a drag, a stale page, or a script — and `press_set_issue_order` refuses an
  order that would leave a piece captioned "Linkpost of …" pointing at nothing.
- **A linkpost is never followed twice.** Only articles saved to `hw` are
  classified; a roundup reached *through* a roundup is left alone, so ingestion
  cannot walk off down the web.

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

**"Make the PDF" queues but nothing happens.** Nothing is claiming jobs — check
that the Fly machine is up (`fly status -a press-worker`) and that its log shows
`worker_started` with a `job_seconds` field. A worker deployed before migration
017 does not know about jobs at all and will leave them queued forever.

**A job is stuck `running` and the button is dead.** The machine died
mid-render. `press_reap_jobs()` fails anything that has not written a progress
line in 30 minutes, and the poll calls it every half hour, so this clears
itself; `SELECT press_reap_jobs('1 minute')` forces it.

**Renders are slow or the machine is out of memory.** Chromium on a 100-page
interior is the heavy step. Raise `memory` in `worker/fly.toml`; the weekly
cadence tolerates minutes.

---

## Local development

```
npm test                          # the whole suite
npx vitest run src/lib/press      # press only
npx tsx scripts/press-preview.ts  # render a sample article to look at
npm run press:linkposts -- --dry-run   # what the pool's linkposts would pull in
```

`scripts/press-preview.ts` writes HTML plus a PDF when a browser is reachable
(set `PRESS_CHROMIUM_PATH` if it is not found). Typography bugs do not show up
in unit tests — look at the PDF.

---

## Translation

Some of the best essays in the reading list are not in English, and the
English-language web only ever carries the fraction someone else chose to
translate — Eurozine is a good source precisely because it does that work for
Russian, German and Polish journals. press does it itself instead, so a
Hungarian essay is a candidate for an issue on the same terms as an English one.

`press-compile` detects the language of every article it extracts and
translates the ones that are not English, **before** anything measures a page
count or names the issue. Nothing downstream knows a translation happened,
except the opener, which says `Translated from the Russian` above the title —
a reader is owed that before the first paragraph rather than after the last,
and no human has checked the English.

```
npx tsx scripts/press-compile.ts urls.txt                 # translate as needed
npx tsx scripts/press-compile.ts urls.txt --no-translate   # leave everything as found
```

Detection costs a Haiku call per article and answers "English" for nearly all
of them; that is the price of not hand-labelling a URL list. Translation itself
uses Opus — it is the one place in press where the model's output *is* the
product rather than a label on it.

Two things are deliberate and worth not undoing:

- **Only text is sent to the model.** The article is flattened into a list of
  strings, translated, and put back in the same slots. Block structure, image
  paths and footnote numbering are never in the request, so they cannot move.
  Bylines and publication names are not translated either — a byline is a real
  person's name. They are *romanized* when they are in a script the magazine
  cannot set: press sets Georgia and Helvetica, which have no CJK or Cyrillic,
  so a byline left alone prints as empty boxes. Same name, Latin script — the
  third option between leaving it and renaming the author.
- **A partial translation is a failure, not a result.** Everything else in
  press degrades gracefully; this throws. Half a translation prints as English
  until it abruptly is not, and a reader cannot tell that from an essay quoting
  its sources in the original. A piece that fails to translate is reported as a
  failure and left out of the issue.

If a chunk comes back cut off by the output limit, pass a smaller `chunkChars`
to `translateArticle` rather than raising `max_tokens`.

## Linkposts

Some of what lands in `hw` is not a piece of writing but a set of pointers at
other writing — a links roundup, "assorted links", a crosspost that exists to
say "this is a linkpost for X". Printed as-is those become pages of anchor text
with the anchors removed, because extraction throws every href away: print
cannot follow one.

So press treats a linkpost as front matter for the reading it names. The post
itself still prints — the commentary is usually why it was saved — and the
pieces it points at are fetched, printed after it, and labelled as belonging to
it, on the opener and on the contents page.

**How the call is made.** A cheap deterministic pass
(`worthClassifying` in `src/lib/press/linkpost.ts`) decides whether a piece is
even worth asking about: link density against body length, how many of the links
stand alone or are headings, how many different sites it points at. Roughly nine
articles in ten never reach the model. The ones that do get a single
`claude-opus-5` call that answers two questions — is this a linkpost, and which
of its pointers are reading in their own right rather than the source of a
number, a book to buy, or a link back into the author's own archive. It is asked
to be selective, because a missed pointer costs the reader little and a printed
pricing page costs them a page.

A declared crosspost ("This is a linkpost for …") skips the model entirely: the
page says what it is.

**Without `ANTHROPIC_API_KEY`, or when the call fails**, the deterministic
answer stands on its own — standalone pointers with real anchor text, one per
site, capped. Blunter, and it never blocks an issue.

**Existing articles.** `npm run press:linkposts` walks everything in the pool
that has never been asked about. Each is re-fetched, because the stored
`article.json` has no hrefs left in it; nothing is re-extracted and no images
are touched. Pieces it finds are queued, and the next `press-run` extracts them
through exactly one code path. `--dry-run` says what it would do, `--force`
re-asks about everything, `--limit N` takes a bite.

**Cost control.** `MAX_TARGETS` (12) is a backstop rather than a policy: the
model is asked for what is actually reading and usually returns a handful, and
this exists so a pathological roundup cannot turn one save into forty items.

## Filling the pool

The issue is only as good as what it is drawn from, and the reading pool has its
own harvest: `npm run press:substack -- --collection <id>`, which pages the
Substack archive API across a configured source list, ranks on engagement, and
caps each publication so no one voice dominates an issue. Method, endpoints and
the reasoning behind every threshold: [press-substack.md](./press-substack.md).
