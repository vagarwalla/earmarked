# CLAUDE.md Alignment Plan — earmarked vs. `vagarwalla/scaffold`

**Status:** proposed (not yet implemented)
**Date:** 2026-08-09
**Baseline compared against:** [`vagarwalla/scaffold`](https://github.com/vagarwalla/scaffold) `CLAUDE.md` (44 lines) + repo conventions

**Revision 2.**
Revision log:
- *Rev 1*: initial diff + phased plan; left two open questions (infra repo, domain).
- *Rev 2*: verified rev 1's open questions and claims. Resolved the domain
  (`earmarked.vaidehiagarwalla.com` — live CNAME to Vercel DNS) and the infra repo
  (`vagarwalla/infra` does **not** exist: absent from the account's complete repo
  list and access-checked directly). Corrected three rev 1 errors: the env-var
  count (9 referenced, 6 user-configurable — not 7), the claim that scaffold's
  `.gitignore` uses a `!.env.example` negation (it doesn't; it ignores specific
  `.env` files instead of a blanket `.env*`, so `.env.example` is simply never
  ignored), and the AI-grouping description (the experiment *rejected* AI grouping
  — the draft now records that verdict instead of presenting the flag as a live
  feature). Added: the `instrumentation.ts` auto-migration gotcha, the
  `AI_GROUPING_RESULTS.md` relocation, and a README/CLAUDE.md authority rule.

## Summary of the diff

**earmarked has no `CLAUDE.md` at all** — not in the working tree, not on `main`, and
never in git history (`git log --all -- '*CLAUDE.md'` is empty). So this is not a
drift-correction between two files; it is a missing file. Everything the scaffold
template says a project must tell an agent, earmarked currently either says to
*humans* in `README.md` or does not say anywhere.

That matters because earmarked is one of the more agent-heavy repos in the account —
it has `.claude/worktrees/`, an `overnight-logs/` directory of autonomous session
notes, and a multi-phase optimizer plan executed by agents. It is exactly the project
that most needs the scaffold's agent-facing contract, and it is the one missing it.

### Section-by-section

| Scaffold `CLAUDE.md` section | earmarked today | Gap |
|---|---|---|
| Title line `# Project — subdomain.vaidehiagarwalla.com` | none | Production domain is `earmarked.vaidehiagarwalla.com` (verified: CNAME → `vercel-dns-017.com`) but it is recorded nowhere in the repo. |
| `## Architecture` | scattered in `README.md` "Stack" | Not agent-facing; omits Next 16 / React 19 / Tailwind v4 versions, the Supabase project ref, the scraper/Playwright runtime, and the `instrumentation.ts` auto-migration behavior. |
| `## Key Decisions` | partially, as README "Naming conventions" | The single most important agent rule in this repo — **user-facing "stack", internal `cart`, do not refactor** — lives only in a human README section. Other load-bearing decisions (deterministic optimizer, the *rejection* of AI edition grouping, migrations skipped on Vercel) are undocumented. |
| `## Database Schema` | `supabase/schema.sql` + 8 migrations | No summary. An agent must read 9 SQL files to learn there are 7 tables. |
| `## Environment Variables` | none | **Worst gap.** Code references 9 env vars (6 user-configurable + 3 platform/runtime: `BENCH`, `NEXT_RUNTIME`, `VERCEL`); `README.md` tells you to `cp .env.example .env.local` but **`.env.example` does not exist in this repo** (scaffold has one). This is a live onboarding bug, not just a docs gap. |
| `## File Structure` | README "Project structure" | Reasonable, but stale — it omits `lib/optimizer/` strategies, `lib/migrate.ts`, `instrumentation.ts`, `GoodreadsImport.tsx`, `CoverPicker.tsx`, and the `cover-hashes`/`cover-groups`/`label-clusters`/`popularity` API routes. |
| `## Definition of Done (runnable signal required)` | none | Scaffold mandates a machine-checkable DONE before implementation starts. earmarked has *more* signal available than the scaffold default (`npm test` — ~15 suites incl. property tests; `npm run bench:optimizer` with a 250ms envelope) but no contract telling an agent to gate on it. |
| `## Infra & global config` | none | Scaffold points at `vagarwalla/infra` as source of truth — but that repo **does not exist** (see Phase 4). The pointer is broken in the template itself, not just missing here. |

### Repo-level conventions earmarked is also missing

- **`.env.example`** — scaffold ships one; earmarked's README references one that isn't
  there. (Note: scaffold's `.gitignore` ignores specific files — `.env`, `.env.local`,
  `.env.production.local` — so its `.env.example` is trackable. earmarked's blanket
  `.env*` rule would swallow the new file without a `!.env.example` negation.)
- **`docs/solutions/<category>/*.md`** — scaffold's knowledge-capture convention, with
  YAML frontmatter (`title`, `date`, `problem_type`, `track`, `category`, `module`,
  `tags`, `applies_when`). earmarked has `docs/` as a flat directory and dumps hard-won
  scraper findings into `overnight-logs/SESSION_NOTES.md` instead, where they are not
  indexed or reusable across projects.

### Stale root files to clean up

1. **`MIGRATION_NOTICE.md`** says of itself "Once all agents have synced, this file is
   no longer needed and can be removed." It dates from 2026-03-24 and contains a
   hardcoded local path (`/Users/vaidehi/projects/recruiting/`). Delete it.
2. **`AI_GROUPING_RESULTS.md`** is a dated (2026-03-12) experiment record whose verdict
   — "AI improvement (0.0 pts) does not exceed 10-point threshold. Heuristics are
   sufficient. No feature flag will be shipped." — is exactly the kind of decision the
   `docs/solutions/` convention exists to preserve. Move it there. Note the wrinkle:
   despite "no feature flag will be shipped," `NEXT_PUBLIC_AI_GROUPING` and the AI
   grouping code path *do* exist in `src/lib/ai-edition-grouping.ts`. The code stayed;
   the verdict was that it shouldn't be on by default. `CLAUDE.md` must state this
   plainly or the next agent will "helpfully" enable it.

### Facts verified for this plan (rev 2)

- `earmarked.vaidehiagarwalla.com` resolves: CNAME `79b7bbf21d117a53.vercel-dns-017.com`
  (same Namecheap→Vercel pattern as `jars.vaidehiagarwalla.com` → `cname.vercel-dns.com`).
- `vagarwalla/infra` does not exist: it is absent from the account's complete repository
  listing and a direct repository-access check confirms no such repo is reachable.
- `instrumentation.ts` auto-applies SQL migrations at dev-server startup (Node runtime
  only) and **deliberately skips on Vercel** — the Supabase Management API is
  unreachable from serverless functions (ETIMEDOUT on cold start). Production
  migrations are manual. This is a classic agent trap and belongs in `CLAUDE.md`.

## Plan

Ordered so the highest-value, lowest-risk work lands first. Phases 1–3 are safe to do
in one pass; Phase 4 needs one decision from you (whether to create a repo).

### Phase 1 — Add `CLAUDE.md` (the main deliverable)

Create `CLAUDE.md` at the repo root, following the scaffold's section order exactly so
the two files stay diffable as the template evolves. Content drafted below in
[Appendix A](#appendix-a--drafted-claudemd). Sourcing:

- Architecture, versions → `package.json`
- Supabase project ref `xkwiugwafgcmcwlyzawq` → `supabase/.temp/project-ref`, `src/lib/migrate.ts`
- Tables → `supabase/schema.sql` + `supabase/migrations/00{1..8}_*.sql`
- Env vars → `grep -roE 'process\.env\.[A-Z0-9_]+' src scripts`
- Key decisions → `README.md` naming section, `docs/OPTIMIZER_IMPROVEMENT_PLAN.md`,
  `AI_GROUPING_RESULTS.md`, `src/instrumentation.ts`

**Authority rule (new in rev 2):** the stack/cart naming rule will now exist in both
`README.md` (for humans) and `CLAUDE.md` (for agents). To prevent drift, trim README's
"Naming conventions" section to a one-line summary pointing at `CLAUDE.md`, which
becomes the authoritative statement. Same for "Project structure" — README keeps the
human-level sketch, `CLAUDE.md` carries the complete agent-facing map.

**Done when:** `CLAUDE.md` exists with all eight scaffold sections filled with
earmarked-specific facts (no placeholder text), and README's naming section defers
to it.

### Phase 2 — Fix the broken onboarding path

Add `.env.example` covering the six user-configurable variables, with the two Supabase
vars matching scaffold's format and the rest commented as optional:

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
# Optional — AI edition grouping experiment (off by default; see CLAUDE.md Key Decisions)
ANTHROPIC_API_KEY=
NEXT_PUBLIC_AI_GROUPING=
# Optional — richer edition metadata
GOOGLE_BOOKS_API_KEY=
# Optional — only for src/lib/migrate.ts (applies SQL via the Management API; local dev only)
SUPABASE_ACCESS_TOKEN=
```

(`BENCH`, `NEXT_RUNTIME`, and `VERCEL` are also read by code but are set by the bench
script and the platform respectively — they don't belong in `.env.example`.)

earmarked's `.gitignore` has a blanket `.env*` rule that would swallow this file — add
`!.env.example` immediately after it. (Scaffold avoids the problem differently, by
ignoring specific `.env` files; the negation is the smaller diff here and keeps
`.env.development.local` etc. ignored.)

**Done when:** a clean clone can follow `README.md`'s setup steps without hitting a
missing file, and `git status` shows `.env.example` as tracked.

### Phase 3 — Adopt the scaffold's DONE contract and knowledge-capture layout

- **DONE signal.** Write earmarked's stack-specific version into `CLAUDE.md`: `npm run
  build` exits 0, `npm run lint` clean, `npm test` green, and — for any change under
  `src/lib/optimizer/` — `npm run bench:optimizer` stays inside the 250ms envelope.
  That last clause is a genuine improvement on the scaffold default and is the kind of
  thing the scaffold asks projects to push back upstream.
- **`docs/solutions/`.** Create the directory and populate it with the two records this
  repo already has, frontmatter per the scaffold example:
  - `docs/solutions/scraping/thriftbooks-bwb-direct-scraping.md` — migrated from
    `overnight-logs/SESSION_NOTES.md`: the ThriftBooks `/browse/?b.search={isbn}`
    redirect trick, the dead `api4.thriftbooks.com` endpoint, the BWB block. Exactly the
    "solved once, hard to rediscover" knowledge the convention exists for. Leave
    `overnight-logs/` in place as a raw session log.
  - `docs/solutions/experiments/ai-edition-grouping-verdict.md` — moved from root
    `AI_GROUPING_RESULTS.md` (content unchanged, frontmatter added).
- Delete `MIGRATION_NOTICE.md`.

**Done when:** `CLAUDE.md` carries the DONE section, `docs/solutions/` has both records
with valid frontmatter, and `MIGRATION_NOTICE.md` and root `AI_GROUPING_RESULTS.md`
are gone.

### Phase 4 — Fix the infra pointer (one decision needed)

Rev 2 verified that `vagarwalla/infra` **does not exist**, so this is no longer
"reconcile" — the scaffold template itself links to a nonexistent repo, in both its
`CLAUDE.md` and `README.md`, and every project generated from it inherits the broken
link. Two coherent paths:

1. **Create `vagarwalla/infra` (recommended).** Seed it with what's currently implicit
   and scattered: the shared Supabase project (`xkwiugwafgcmcwlyzawq` / `bookbundle`)
   and which projects share it, the Namecheap → Vercel CNAME runbook from scaffold's
   README, the `*.vaidehiagarwalla.com` subdomain registry (at minimum: `jars`,
   `earmarked`, apex). Then earmarked's `CLAUDE.md` ships with the standard scaffold
   wording, true on arrival.
2. **Re-point the template at `vagarwalla/scaffold`.** Cheaper today, but scaffold then
   plays two roles (template + infra source-of-truth), and the reference would need
   changing in scaffold's own two files plus any other generated project.

Recommendation: **(1)** — two files already commit to `infra` existing; making it real
is cheaper than unwinding the reference everywhere. Creating the repo is your call,
not something this plan does unilaterally. **Sequencing:** Phases 1–3 don't block on
this. If `CLAUDE.md` merges before `infra` exists, its infra section should carry an
interim parenthetical — "(repo not yet created — falls back to `scaffold` until then)"
— removed once the repo is real.

### Explicitly out of scope

- Renaming `src/components/providers.tsx` → `Providers.tsx` to match scaffold casing.
  Cosmetic, and case-only renames are hostile on macOS checkouts.
- Reconciling `src/app/globals.css` with scaffold's design tokens. earmarked has its own
  established look; the scaffold palette is a starting point, not a standard.
- Any change to `/api/cart/*` routes, TS types, or the DB schema. The README's rename
  rule stands and Phase 1 promotes it into `CLAUDE.md` rather than acting on it.
- Enabling or removing the AI-grouping code path. The experiment's verdict stands;
  `CLAUDE.md` documents it, nothing more.

## Appendix A — drafted `CLAUDE.md`

```markdown
# Earmarked — earmarked.vaidehiagarwalla.com

Find cheap used books and minimize shipping costs. Build a stack of books, pick
editions, and Earmarked finds the cheapest way to buy them all by grouping sellers.

## Architecture
- **Framework**: Next.js 16.1.6 (App Router) with TypeScript + Tailwind CSS v4, React 19.2
- **UI**: shadcn/ui + Base UI, `next-themes` dark/light, `sonner` toasts
- **Backend**: Supabase (shared project `xkwiugwafgcmcwlyzawq` / `bookbundle`)
- **Scraping**: `playwright-core` + `@sparticuz/chromium` running inside Vercel functions
- **Hosting**: Vercel, domain `earmarked.vaidehiagarwalla.com`; `vercel.json` raises
  `maxDuration` on the scraping routes (`prices`, `cover-hashes`, `cover-groups` to
  60s; `popularity` to 30s)
- **Migrations**: `src/instrumentation.ts` auto-applies `supabase/migrations/` at local
  dev-server startup (Node runtime only). **On Vercel this is deliberately skipped** —
  the Supabase Management API is unreachable from serverless functions (ETIMEDOUT).
  Production schema changes are applied manually. Do not "fix" the skip.
- **Database tables**:
  - `carts` — a stack (slug-addressed)
  - `cart_items` — books in a stack, with per-item filters
  - `price_cache` — cached listings from ThriftBooks / BWB / AbeBooks
  - `cover_hashes` — perceptual dHashes of cover images
  - `cover_similarity` — pairwise cover distances
  - `cover_group_cache` — cached cover-grouping results
  - `isbn_popularity` — popularity signal used to rank editions

## Key Decisions
- **"Stack" is the user-facing word; `cart` is the internal word.** UI copy and URLs
  (`/stack/[slug]`) say stack. TypeScript types, variables, API routes (`/api/cart/...`)
  and the DB schema still say cart, deliberately, to avoid a large refactor.
  **Do not rename them.** New user-facing copy uses "stack".
- **Edition grouping is heuristic, not AI — by measured decision.** A 2026-03
  experiment (Sonnet grouper vs. `groupEditionsByCover()`, Opus judge) found 0.0 points
  of improvement against a 10-point ship threshold. The AI code path
  (`src/lib/ai-edition-grouping.ts`, flag `NEXT_PUBLIC_AI_GROUPING`) remains for future
  experiments but is **off by default — do not enable it** without a new experiment
  beating the threshold. See `docs/solutions/experiments/ai-edition-grouping-verdict.md`.
- The optimizer is **deterministic** — seeded RNG, byte-identical results across runs.
  Determinism is a prerequisite for the test suite; don't introduce unseeded randomness.
- Optimizer strategies live behind one entry point (`src/lib/optimizer/index.ts`):
  greedy, exact, local-search, and a combined warm-start. Exact search is node-capped.
- Listings are scraped directly from ThriftBooks and Better World Books (BookFinder was
  replaced in March 2026); AbeBooks has its own condition-group handling. Scraper
  endpoint discoveries are recorded in `docs/solutions/scraping/`.
- Quantity buys distinct copies — per-listing stock is modeled, not assumed infinite.
- Light/dark mode with theme toggle (next-themes), preference stored in localStorage.

## Database Schema
Source of truth is `supabase/schema.sql` plus `supabase/migrations/001..008`. Locally,
migrations auto-apply at dev-server startup via `src/instrumentation.ts` (needs
`SUPABASE_ACCESS_TOKEN`); on Vercel they are manual (see Architecture).

## Environment Variables
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key
- `ANTHROPIC_API_KEY` — optional; AI edition-grouping experiment only
- `NEXT_PUBLIC_AI_GROUPING` — optional; feature flag for AI grouping (off by default)
- `GOOGLE_BOOKS_API_KEY` — optional; supplementary edition metadata
- `SUPABASE_ACCESS_TOKEN` — optional; only for `src/lib/migrate.ts` (local dev)

(`BENCH`, `NEXT_RUNTIME`, `VERCEL` are also read but are set by the bench script /
platform — never configure them in `.env.local`.)

## File Structure
- `src/app/page.tsx` — homepage, lists all stacks
- `src/app/stack/[slug]/page.tsx` — individual stack page
- `src/app/api/cart/` — REST API for stacks (internally "cart")
- `src/app/api/prices/` — live listing fetch (scrapers)
- `src/app/api/optimize/` — seller-grouping optimizer endpoint
- `src/app/api/goodreads/` — ratings lookup + shelf import
- `src/app/api/{editions,search,popularity,cover-hashes,cover-groups,label-clusters}/`
- `src/lib/supabase.ts` — Supabase client singleton (lazy Proxy)
- `src/lib/optimizer/` — strategies, batching, validation, seeded RNG, benchmarks
- `src/lib/{thriftbooks,abebooks,openLibrary,coverGrouping,dhash,clustering}.ts`
- `src/lib/migrate.ts` — applies SQL via the Supabase Management API
- `src/instrumentation.ts` — dev-only auto-migration hook
- `src/components/` — React components
- `docs/solutions/` — reusable findings (scaffold convention)

## Definition of Done (runnable signal required)
Every plan or task MUST define DONE as an objective, machine-checkable signal — not
prose. Do not start implementation until it is specified. Default for this project:

- `npm run build` exits 0
- `npm run lint` passes clean
- `npm test` passes (Vitest — API, scraper, and optimizer property tests)
- For any change under `src/lib/optimizer/`: `npm run bench:optimizer` stays within the
  250ms-per-scenario envelope
- The affected page/route renders correctly in the Vercel preview deploy (or local
  `npm run dev`)

Add task-specific checks on top. Autonomous skills (`ce-work`, `lfg`, `executing-plans`)
run against this signal and must not declare success until it passes.

## Infra & global config
Generated from [`vagarwalla/scaffold`](https://github.com/vagarwalla/scaffold). Personal
global config and infrastructure — the global `CLAUDE.md`, DNS, accounts, deploy
runbooks, setup scripts — live in
[`vagarwalla/infra`](https://github.com/vagarwalla/infra), the single source of truth.
*(Repo not yet created as of 2026-08-09 — falls back to `scaffold` until then; see
`docs/CLAUDE_MD_ALIGNMENT_PLAN.md` Phase 4. Remove this note once it exists.)*

If this project introduces anything infra-level (a new subdomain, a Supabase table
convention, an env-var pattern, a deploy quirk, a reusable script), record it in
`vagarwalla/infra` — not only here.
```

## Appendix B — candidate upstream contributions

Things this exercise surfaced that belong upstream, worth pushing back:

- **To `vagarwalla/scaffold`:**
  - **A test script in the DONE signal.** Scaffold's default DONE has no `npm test`
    because scaffold ships no test setup. Adding Vitest + a `test` script to the
    template would make the DONE contract meaningful from day one.
  - **Performance-envelope DONE clauses.** The `bench:optimizer` pattern (a benchmark
    that fails outside a fixed time envelope) generalizes as an optional DONE clause.
  - **`vercel.json` `maxDuration` guidance.** Any scaffold project doing scraping or AI
    calls will hit the default function timeout; the template says nothing about it.
  - **The broken `infra` link.** Scaffold references `vagarwalla/infra` in two files;
    the repo doesn't exist. Whichever way Phase 4 resolves, scaffold needs the same fix.
- **To `vagarwalla/infra` (once it exists):** the shared-Supabase-project registry, the
  subdomain → CNAME runbook, and the "instrumentation auto-migration skips on Vercel"
  pattern — all currently discoverable only by reading earmarked's source.
