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

### Signing in

Supabase Auth, magic link, **open**. `PRESS_PASSWORD` and the HTTP Basic
middleware are gone: one shared password could not say which account you were,
and that is the only question the workbench now asks.

Anybody who can read mail at an address can have a press. Following the link
makes the account if there is not one already, and it starts empty — their own
pool, their own issue numbers from 1, nothing of anybody else's. The handle
comes from the address: `alex.whitby+reading@example.com` becomes `alex-whitby`,
with `-2` appended if that is taken.

- `/press/sign-in` takes an address and mails a link. The account is made on the
  far side, when the link is followed, so an address typed by mistake leaves
  nothing behind.
- `/press/auth/callback` exchanges the code, attaches the Supabase user to the
  invitation, and refuses — signing back out — if there is no invitation.
- `src/middleware.ts` refuses everything else without a session: a redirect for
  a page, a 401 for an API route. It fails *closed* if the Supabase keys are
  missing, which is the opposite of what `PRESS_PASSWORD` did.
- The approval loop is untouched: `/press/confirm/[token]`,
  `/api/press/action/[token]` and `/api/press/email-in` carry their own
  credentials and stay outside the matcher.

### The owner's own way in, deployed

A magic link is right for somebody signing in once. It is wrong for the person
who owns the thing and just wants to open it — and on the deployed site the
laptop bypass below does not apply.

So: `PRESS_OWNER_KEY`, a long random secret in the environment, exchanged once
at `/press/enter?key=…` for a cookie that lasts a year. Bookmark that URL and
it is a button — one click, straight into the workbench.

```bash
openssl rand -hex 24            # then set it as PRESS_OWNER_KEY
```

**The URL is a password.** Anybody holding it is the owner: every article,
every order, the shipping address. It belongs in a bookmark and nowhere else —
not in a message, not in a screenshot, not in this repo. It is the same bargain
`PRESS_PASSWORD` made, which is why it is opt-in: with `PRESS_OWNER_KEY` unset
the route does not work at all.

- `/press/enter?leave=1` clears the cookie on this browser.
- Changing `PRESS_OWNER_KEY` invalidates every browser holding it at once,
  which is the whole of "sign out everywhere".
- A wrong key and an unset key both 404, so probing the URL says nothing about
  whether there is anything to find.
- The sign-in page has an **"I have an owner key"** button, shut by default,
  that opens a single field. Paste the key, same cookie, same year — for a
  browser that does not have the bookmark. What is deliberately *not* there is
  the key itself: a button whose href carried it would put a permanent
  credential in the HTML of a page anybody can open, which would make the
  sign-in page it sits on pointless. It posts rather than using `?key=`, so the
  secret stays out of the URL bar, history and referrers.
- The button only appears where `PRESS_OWNER_KEY` is set. Advertising a door
  that cannot be opened is worse than showing nothing.
- Signing out clears this cookie too — otherwise it would put you straight
  back on the workbench.

### On a laptop there is nothing to sign in to

`/press` on localhost is the owner's, with no session and no link. This is how
press behaved for its whole life before sign-in existed — `PRESS_PASSWORD`
unset meant open, and the file that did it said "localhost stays frictionless"
in as many words.

It gives away nothing. Reaching press at all needs `.env.local`, and
`.env.local` holds `SUPABASE_SERVICE_ROLE_KEY` — every account's everything,
session or no session. Asking somebody holding that key to prove who they are
is ceremony, not security.

It is the **Host header**, not "not production": put a dev server behind a
tunnel to look at it from your phone and it asks for a session, exactly as the
password did. `VERCEL` being set rules out preview deployments too.

`PRESS_REQUIRE_SIGN_IN=1` turns it off, for checking the signed-in path from a
laptop. It is read in `runningLocally()` and deliberately *not* in the
middleware: Next inlines `process.env.X` at build time in server chunks as well
as client ones, so a flag set at start-up has no effect there — and an escape
hatch that silently does nothing is worse than none. For the same reason it is
read as `process.env['PRESS_REQUIRE_SIGN_IN']`, which survives the inlining.

`NEXT_PUBLIC_SUPABASE_ANON_KEY` is required wherever the app is *deployed* —
the session client uses it, and without it the middleware refuses every
request. Locally it is optional: with no key nobody can be signed in, which is
the honest answer and the laptop case anyway.

### Inviting somebody

Addresses are not in this repo — it is public, which is why 018 seeds the owner
with no email at all.

```bash
npm run press:invite -- --owner you@example.com     # the owner's own address
npm run press:invite -- alex@example.com alex "Alex Whitby"
npm run press:invite -- --list
```

Not required any more — anybody can sign in and get a press. It is still worth
running when you want somebody to have a *particular* handle: it writes the row
first, and their first sign-in claims it instead of deriving one from their
address. It also creates the Supabase user, which is what `PRESS_INVITE_ONLY`
mode needs.

Nobody but the owner gets `can_order` — ordering bills the one Lulu account on
file, so a friend's finish line is the PDFs.

### What a friend gets instead of an order button

On a locked issue, where the owner sees **Order a copy**, an account without
`can_order` sees **Ready for a printer**: the interior and the cover as two
downloadable PDFs, and the print spec — trim, binding, paper, spine width for
this page count — decoded from the same POD package id an order would use. It
is what V uploads by hand when the API is not involved.

The button is *absent*, not disabled with a tooltip: a button that exists and
refuses is a support question. And it is not only absent — `/api/press/order`
and `/api/press/issue/<n>/order` both call `orderingAccount()` before they read
anything, because a button the workbench does not render is not a check, and
these are the routes where being wrong costs a real parcel.

Two gates and they mean different things. `PRESS_ORDER_ENABLED` is V's own
safety catch on a button that spends money and she can turn it back on;
`can_order` is not how a friend's press works at all, and telling them to set
an environment variable would be telling them to fix something that is not
broken.

### Closing the door again

`PRESS_INVITE_ONLY=1` puts it back to the `press_accounts` list: the sign-in
form checks the address before Supabase is asked to send anything, and an
unknown one is refused. Read at runtime — as `process.env['PRESS_INVITE_ONLY']`,
because Next inlines the dotted form at build time in server chunks.

If it ever needs closing for real, turn signups off in the Supabase project as
well. The anon key is in the page, so `PRESS_INVITE_ONLY` alone stops the form
but not somebody sending the same request straight to GoTrue — they would get a
Supabase user and no press, which is harmless but is still this project sending
mail on their say-so.

### What an open door actually costs

An account is somebody who can make the one Fly machine render a hundred pages
and make this app fetch arbitrary URLs on its own network. The controls are:

| | |
|---|---|
| Fetching | `fetch.ts` resolves every redirect hop and refuses private, loopback and link-local addresses |
| Volume | Fifty links a paste, two hundred a day, **per account** (`paste.ts`) |
| Money | `can_order` is false for everybody but the owner, and is not a parameter anywhere — no sign-in can reach it |
| Renders | One job per issue, one at a time, on one machine — a queue rather than a stampede |
| Sign-up rate | Supabase's built-in mailer sends only a couple of links an hour, project-wide. That throttles abuse and it also throttles **you** — several friends signing up the same evening will hit it. Configure SMTP if that happens |

What is *not* controlled is storage: every account's articles and PDFs live in
one bucket. Worth a size check before this goes past a handful of people.

### Supabase project settings this depends on

| Setting | Value | Why |
|---|---|---|
| Auth → signups | **enabled** | A first sign-in has to be able to create a Supabase user. `PRESS_INVITE_ONLY` is the app-level door |
| Auth → redirect URLs | `…/press/auth/callback` for localhost, the production domain, and `https://*-<team>.vercel.app` | Supabase only honours redirects on this list; without it a magic link goes nowhere but `site_url` |
| Auth → email | built-in sender | Rate limited to a couple an hour. Fine at this size; configure SMTP if "too many links requested" ever becomes routine |

### Filling a friend's pool

Raindrop and the email door run on V's credentials, so neither is a way in for
anybody else. A textarea is: paste a block of links into the pool panel and
they land `queued`, which the worker's existing extraction picks up on its next
pass — the same path a Raindrop drop takes.

It reports everything: what was added, what this press already had, what was
repeated in the paste, and what was not a link at all. A paste that quietly
absorbs half its input is the same failure as the dedupe key that used to
swallow somebody's article.

Markdown links, `<angle brackets>` and trailing punctuation are all unwrapped,
because that is how a link arrives when somebody copies one out of a
newsletter. Fifty links a paste, two hundred a day per account — the pipeline
is one machine shared by everyone, and the cost of a runaway paste is
everybody else's issues waiting behind it.

The **arriving** chip in the pool panel is everything queued or extracted but
not yet measured. It exists because a paste of ten links otherwise leaves the
pool looking untouched for a couple of minutes, and a pool that looks untouched
is a paste somebody makes twice.

### Sharing an issue

A built issue has a switch in the workbench: **Share this issue**. Shared means
anyone with the link, and there is deliberately no second setting for "listed
on my shelf" — `/press/by/<handle>` is a page anyone can open, so an issue
listed there is an issue anyone can read, and pretending otherwise would be a
privacy control that does not do what it says.

| URL | What it is |
|---|---|
| `/press/by/<handle>` | Somebody's shared issues, newest first |
| `/press/i/<handle>/<n>` | One issue: the contents, and the PDFs |

Both are outside the middleware's matcher, because the whole point is that they
open without a session.

Read-only is not enforced by hiding buttons. It falls out of the ownership
scoping: every editing route resolves its issue through the *caller's* own
scoped client, so a stranger POSTing to `/api/press/issue/3/lock` gets a 404
for an issue that plainly exists — which is the correct answer. What
`src/lib/press/shared.ts` decides is only what a reader is shown, and what it
returns is a projection with no ids in it.

PDF links are signed and last an hour. They are downloadable: anything shared
can be reprinted by whoever has the link.

An issue that has never been built cannot be shared — the route refuses it and
the switch is not rendered. A shared draft would be a page offering a PDF that
does not exist, and a reader cannot tell that from a broken link.

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
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The publishable key. Sign-in needs it, and the middleware refuses every request without it — deliberately, so a half-configured deployment is shut rather than open. |
| `PRESS_OWNER_KEY` | Optional, ≥32 chars. The owner's one-click way into the deployed workbench: `/press/enter?key=…`, bookmarked. Treat the URL as a password. Unset means the route 404s. |

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

### Mail out (worker) — optional

The worker boots without any of these. Nothing it exists to do needs a mailer:
fetching saved links, laying them out and rendering an issue are the whole job,
and a machine that will not start because it cannot send a summary of what it
did is a machine that never does anything to summarise.

Without them the log says `no_mailer` at boot and `digest_skipped` on the
weekly tick, and ordering hands the approval link back in the response instead
of emailing it (`d3f908f`).


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
