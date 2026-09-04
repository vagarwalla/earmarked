# press — audit, 2026-09-03

A read of the press subsystem end to end, and what was done about it.

Scope: `src/lib/press/**`, `src/app/press/**`, `src/app/api/press/**`,
`scripts/press-*.ts`, `docs/press-runbook.md`, `docs/press-substack.md`.
About 19,000 lines, of which 8,000 are tests. Read against `main` at
`544a181`.

The headline is that this is unusually well-kept code. Almost every constant
carries the reasoning behind its value, almost every workaround names the
issue that produced it, and several comments name the specific printed
magazine that went wrong. Most of what follows is small. Two findings are not.

> **Since written:** press was parked on 2026-09-04 — see
> [the handover](press-handover.md). The blocker there is deploying the Fly
> worker, not code, so nothing below is superseded by the parking; the PRs this
> document describes are cleanup that stands whenever press is picked up again.
> `main` has moved several times since the read, and this document has been
> kept level with it: the verification numbers were re-run, and one finding
> (`ItemState`) was fixed on `main` in a better way than proposed here, which
> is recorded at that entry.

---

## The two invariants

Both were checked directly rather than taken on trust.

### 1. Comment threads must never reach a printed issue

**Held, with one real hole, now closed.**

The defence is three-layered and correctly ordered:

- `stripCommentSections` runs on the *raw* document before defuddle or
  Readability chooses what the article is. That ordering is load-bearing and
  the code says why: a long thread is a big block of prose, so leaving it in
  makes the extractors *more* confident they have found the content.
- `stripExternalReferences` carries the same selector list, which is what
  covers the newsletter door — newsletters skip the ladder entirely, so
  `stripCommentSections` never runs on them.
- The selectors anchor on a separator (`comment-`, `-comment`, `comment_`,
  `Comment`) so that "commentary" and "commented" survive.

**The hole:** the anchoring works for the singular and leaves the plural out.
`comments-area`, `comments-section` and `comments_wrapper` match none of the
selectors, because each contains `comments-`, not `comment-`. `comments-area`
is WordPress's own theme markup — `<div id="comments" class="comments-area">`
— and only the `#comments` id was catching it, so any theme that renames or
drops the id put the entire thread through both passes untouched. The
newsletter door is worse off, having nothing but `stripExternalReferences` in
front of it.

Fixed by adding `[class*="comments"]` and `[id*="comments"]`. The plural does
not need the separator: no English word continues past "comments", so this
cannot reach "commentary" or "commented", and there is now a test holding that
down. **This is the one behaviour change in this work.**

Coverage before: one test, one page, two containers. After: one case per
markup shape that has put replies on a page or would have (bare `#comments`,
LessWrong's `CommentsListSection`, the EA Forum's `comment-body`, a striped
reply row, an underscored class, a WordPress comment id, Disqus, giscus,
utterances, a leftover `data-testid`, an `aria-label`led region, and the three
plural spellings above), plus three cases the single test could not reach:

- the newsletter door, which has only the second layer in front of it;
- footnotes — a thread carrying a "Notes" heading and a list is exactly the
  shape `extractFootnotes` looks for, so comments that survived that far would
  print numbered and looking authored, which is worse than printing them as
  prose;
- the negative, that "commentary" and "commented" are left alone.

### 2. Non-article pages must never be selected into an issue

**Held on one of the two runtimes. The gap is a recommendation below, not a
change.**

The rule is `isReferencePage`: a title that is *entirely* a generic noun
("About", "Docs", "Getting started") marks the item `skipped` rather than
`laid_out`. `skipped` is then unselectable — `readyItems` filters on
`laid_out`, and `applyIssueAction` refuses to add anything else by hand.

Two problems, one fixed and one not:

- It lived in `scripts/press-run.ts` and had **no test at all**. Moved to
  `src/lib/press/reference-page.ts` and covered: the titles it catches, the
  essays it must *not* catch (an essay called "About a Boy" silently missing
  from an issue is the failure nobody would go looking for), and the part that
  makes it an invariant — that a `skipped` item cannot then be selected
  automatically or added by hand.
- **It only ever runs on the local runner.** The deployed pipeline has no
  equivalent check. See *Recommendation 1*.

---

## What was changed

Five PRs, in this order. Each one keeps `npm test`, `npx tsc --noEmit` and
`npm run lint` at or better than where it found them.

### Dead code

- `allImages` (compose.ts) — no callers anywhere, tests included. Its own doc
  comment said "used by the worker to warm storage reads"; the worker does
  not, and has not since compose took over image loading.
- `formatBytes` (local.ts) — no callers anywhere.
- `stripExternalReferences` narrowed its argument through `ownerDocument`
  before picking a scope. Both `Element` and `Document` carry
  `querySelectorAll`, so the ternary always chose `root` and the `doc` binding
  was never read. The dead branch implied a shape the function had to cope
  with, and there is not one.
- `isPrintRun` asked for two fields it never looks at, one of which
  (`issue_idempotency_key`) exists on no type in the schema.
- `refreshOrders`' doc comment had been stranded above `isPrintRun` when that
  was inserted between the two, so it documented the wrong function.
- A shadowed `items` in `performBundledApproval`: the inner one is the issue's
  articles, the outer one the job's line items.

### One definition each, for rules that had several

- **`isReferencePage`** — see above.
- **`escapeHtml`** existed three times: `layout/render.ts`, `approval.ts`,
  `digest.ts`. The two email copies did not escape the apostrophe, which is
  safe inside an element and not safe inside a single-quoted attribute. The
  copies existed because importing `render.ts` drags in pdf-lib and the
  filesystem, so the shared definition went into a new `html.ts` that imports
  nothing; `render.ts` re-exports it, so no call site changed.
- **`sameOrder`** — "is this issue's running order the one its PDFs were built
  from" — existed identically **four** times: `local.ts`, `remote.ts`, the
  workbench page, and `scripts/press-sync.ts`. Now beside `tocMeta` in
  `types.ts`, which exists for exactly this reason.

  The fourth was missed on the first pass and found later, because the search
  that caught the other three did not cover `scripts/`. It is the one that
  matters most: the other three decide whether a page reads "edited since the
  last build", while press-sync's decides whether to spend minutes of headless
  Chromium re-rendering an issue. Worth recording as a lesson about the shape
  of this codebase — press has two runtimes and its `scripts/` half is real
  production code, not tooling, so a duplication sweep that stops at `src/`
  will keep finding three of four.
- **`PRESS_ROOT`** was recomputed in `handoff.ts`, which already imports
  `withStateLock` from the module that exports it.
- **`ItemState`** was exported by both `issues.ts` (five states, the disk) and
  `types.ts` (eight states, Postgres), with both names in scope in the same
  files.

  This audit proposed renaming the local one to `LocalItemState`, reasoning
  that the disk and the database are different state machines and should not
  share a type. `main` reached the same finding independently and fixed it the
  other way — `issues.ts` now re-exports the unified type — and **that is the
  right answer, not this one.** The five-state list was not a narrower correct
  type; it omitted `in_issue`, which `.press/state.json` is full of. Keeping
  the two apart would have preserved a type that does not describe its own
  data. `main`'s resolution was taken on merge, and `local.ts` aliases
  `LocalItemState` to it so its callers are untouched.
- **`fetchAndStoreImages`** was hand-rolled twice — the same sequential loop
  with the same gap-free numbering — in `press-run.ts` and `press-compile.ts`.
  Both copies were cast `as never` to get past the type checker; neither cast
  was needed once the argument had the right shape.

### Comments and small refactors

- **`translate.ts` was not a text file.** Its `NON_LATIN` range was written
  with the characters themselves rather than escapes, and the first of them is
  a NUL byte — so `file` reported the module as `data`, and grep and ripgrep
  skipped it as binary. Every code search over this repo has been silently
  missing `translate.ts`. Rewritten with `\u` escapes and proved identical
  over the whole BMP before committing.
- `composeIssue` built the same contents-page document twice, ten lines apart,
  because the second render corrects the first one's estimate. `buildIssue`
  already expresses that as a `renderFront` closure; compose does now too.
- `TOC_ENTRIES_PER_PAGE` said it was "only used to sanity-check the rendered
  count". It is not a check, it is the first guess — a contents page cannot
  state where anything starts until it knows its own length.
- `PRINT_SPEC.pagesPerInch` said "for 80# coated stock", which the stock has
  not been since 2026-09-01 (the note twenty lines above records the move to
  60# uncoated at the same 444 ppi).
- `buildIssue` cast its entries to reach `.article` twice. A local build has
  no PDF items — a PDF only ever arrives through the email door, which is
  deployed-only — so the array says so in its type and both casts go.
- Documented the retry in `withBuildLock`, and that the `-copy-` segment of an
  idempotency key is read back by `isPrintRun` rather than being cosmetic.

### Tests

- The two invariants, above.
- **The press test factories did not typecheck.** Nine of them spread a
  `Partial<T>` over an object literal, which widens every field the partial
  declares back to `| undefined`, so the result stops being a `T`. That was
  twelve of the forty errors `npx tsc --noEmit` reported on `main`, across
  five press test files; one had been silenced with `as PressIssue`. They now
  build a named, typed base and `Object.assign` the overrides onto it, which
  restores the checking — and that immediately surfaced three columns the
  fixtures had never carried (`owner_id`, `visibility`, `shared_at`).
- Two call sites passed `{}` where a client was required. They now name a
  client they do not use and say why they do not use it, which is also the
  point of each test: both paths refuse from the row alone, before any query.
- One vacuous test removed: "keeps the article when a stray selector cannot be
  parsed" parsed no stray selector and asserted only that a plain page did not
  throw. Replaced with a real one — that a thread is stripped whether the
  function is handed a whole document (the URL path) or one element (the
  newsletter path).

No test was made to hit the network or a database. Every new test is pure.

---

## Recommendations — not changed

Each of these is either a behaviour change, a judgement call, or needs a live
service to settle. They are listed in the order I would take them.

### 1. The reference-page rule does not run on the deployed pipeline

`isReferencePage` is called from `scripts/press-run.ts` and nowhere else. An
About page that arrives through the email door, a paste, or the Raindrop poll
on the Fly worker is extracted, measured and dropped into the pool as
`laid_out` like any essay, and the workbench will happily put it in an issue.

The invariant therefore holds on V's laptop and not on the deployment. The
rule is now importable from `src/lib/press/reference-page.ts` precisely so
this can be wired in, but doing so is a behaviour change to the deployed
ingest path — it would start marking rows `skipped` that are `laid_out`
today — and it wants somebody to decide whether the pool should be swept
retroactively as well. Left out on purpose.

### 2. `raindrop.ts` contains two comments that contradict each other

`listRaindrops` sends `sort: 'created'` and says *"Oldest first: the poll walks
forward from the cursor."* `pollRaindrops`, twenty lines down, says *"Raindrop
pages newest-first, so later pages hold OLDER drops — take the high-water mark,
or the cursor would walk backwards and rescan forever."*

Both cannot be true, and which one is decides whether the cursor arithmetic is
right. `press-run.ts` separately carries a comment about a poll that only ever
read page 0 and lost 33 of 66 saves, which suggests this area has been
genuinely confusing. Settling it needs one call against the live Raindrop API,
which this environment has no credentials for. I did not want to "correct" a
comment by guessing which half was wrong.

### 3. The two measurement passes disagree about the folio

`composeIssue` measures each article **without** `measurement: true`; the new
measurement loop in `buildIssue` measures **with** it. The flag drops the
running footer, which lives in a page margin box and should not affect flow —
so the counts should agree — but "should" is doing work there, and the whole
point of measuring is that the number is exact. Worth making the two identical,
after checking which is right against a real render.

### 4. `renderArticles` has no production caller

`layout/render.ts` documents it as "U5's compose step", and U5 does not use
it: `composeIssue` calls `buildDocument` and `renderHtml` directly. Only its
own test reaches it. Deleting it means deleting a coherent, tested public API
whose header comment describes a flow the code no longer follows, so it is a
judgement call rather than obvious dead code.

### 5. Three different `BuildItem` types

`build.ts`, `handoff.ts` and (by inheritance) `local.ts` each declare a
`BuildItem`, with different nullability on `title` and `pageCount`. They
describe the same article crossing the same boundary. Unifying them touches
the website↔disk handoff, which is the seam with the most history in this
subsystem, so it wants doing deliberately rather than as tidying.

### 6. Four functions named `itemsInState`

`db.ts` (`states[], db, limit`), `workbench.ts` (`state, db`), `local.ts`
(`state, want`), and `remote.ts`'s `remoteItemsInState`. Only the last is
named for where it reads from. Renaming is easy and touches a lot of call
sites for no behaviour; worth doing when one of them is next edited.

### 7. `CAP_BY_SOURCE` names a source that is not harvested

`substack-sources.ts` sets a cap of 14 for `www.astralcodexten.com`, which
does not appear in `SOURCES`. It may be deliberate — the file's comments
describe hand-picked items the reconcile does not touch — but a cap for a
publication nothing harvests is either a leftover or a missing source, and
only the author knows which.

### 8. `Workbench.tsx` is 1,609 lines

By some distance the largest file in the subsystem, and the only place where
"over-long" is really the right word. It was left alone entirely: it is UI
with a lot of local state, splitting it is a design decision rather than a
cleanup, and none of the rest of this work needed to touch it.

---

## Verification

`npm ci`, then, with every branch brought up to `main` at `c5fcfb7`:

| | before | after |
|---|---|---|
| `npm test` | 938 passed, 1 skipped | 963 passed, 1 skipped |
| `npx tsc --noEmit` | 40 errors (12 in press) | 28 errors (**0** in press) |
| `npm run lint` | 6 errors, 23 warnings | 6 errors, 23 warnings |

The read was done against `main` at `544a181`, where the same commands gave
923 / 40 / 6. `main` has moved several times since — re-measuring article
lengths on every build, a `--force` rebuild flag, title cleaning, page-count
balancing, nine covers — and those commits carry the extra tests. The before
column is the current `main`, re-run, so the two columns are comparable. Only
one of those commits touched a finding here, and it is noted at the
`ItemState` entry.

The 28 remaining type errors and all 6 lint errors are outside press —
`src/app/api/cart/__tests__`, `src/lib/__tests__`, `src/components/*` and
`scripts/test-ai-grouping.ts` — and were there before. Press itself is clean
under `tsc`; it was not before.

There is no `.env.local` in this environment and no Supabase, Raindrop, Lulu
or Anthropic credentials, so **nothing was run against a live service**: no
Raindrop poll, no Lulu quote or order, no Supabase query, no model call, no
Vivliostyle render against a real browser. Every check above is the offline
suite. The two things that genuinely need a live service to settle are
recommendations 2 and 3.
