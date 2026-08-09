# CLAUDE.md Alignment Plan — earmarked vs. `vagarwalla/scaffold`

**Status:** proposed (not yet implemented)
**Date:** 2026-08-09
**Baseline compared against:** [`vagarwalla/scaffold`](https://github.com/vagarwalla/scaffold) `CLAUDE.md` (44 lines) + repo conventions

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
| Title line `# Project — subdomain.vaidehiagarwalla.com` | none | No custom domain is recorded anywhere in the repo. Deploy target is Vercel (`vercel.json` exists) but the hostname is undocumented. |
| `## Architecture` | scattered in `README.md` "Stack" | Not agent-facing; omits Next 16 / React 19 / Tailwind v4 versions, the Supabase project ref, and the scraper/Playwright runtime. |
| `## Key Decisions` | partially, as README "Naming conventions" | The single most important agent rule in this repo — **user-facing "stack", internal `cart`, do not refactor** — lives only in a human README section. Other load-bearing decisions (deterministic optimizer, cache tables, AI grouping behind a flag) are undocumented. |
| `## Database Schema` | `supabase/schema.sql` + 8 migrations | No summary. An agent must read 9 SQL files to learn there are 7 tables. |
| `## Environment Variables` | none | **Worst gap.** 7 env vars are read by code; `README.md` tells you to `cp .env.example .env.local` but **`.env.example` does not exist in this repo** (scaffold has one). This is a live onboarding bug, not just a docs gap. |
| `## File Structure` | README "Project structure" | Reasonable, but stale — it omits `lib/optimizer/` strategies, `lib/migrate.ts`, `instrumentation.ts`, `GoodreadsImport.tsx`, `CoverPicker.tsx`, and the `cover-hashes`/`cover-groups`/`label-clusters`/`popularity` API routes. |
| `## Definition of Done (runnable signal required)` | none | Scaffold mandates a machine-checkable DONE before implementation starts. earmarked has *more* signal available than the scaffold default (`npm test` — ~15 suites incl. property tests; `npm run bench:optimizer` with a 250ms envelope) but no contract telling an agent to gate on it. |
| `## Infra & global config` | none | No pointer to `vagarwalla/infra` as source of truth, and no instruction to record infra-level findings upstream. |

### Repo-level conventions earmarked is also missing

- **`.env.example`** — scaffold ships one; earmarked's README references one that isn't there.
- **`docs/solutions/<category>/*.md`** — scaffold's knowledge-capture convention, with
  YAML frontmatter (`title`, `date`, `problem_type`, `track`, `category`, `module`,
  `tags`, `applies_when`). earmarked has `docs/` as a flat directory and dumps hard-won
  scraper findings into `overnight-logs/SESSION_NOTES.md` instead, where they are not
  indexed or reusable across projects.

### Two things to fix while we're here

1. **`MIGRATION_NOTICE.md`** says of itself "Once all agents have synced, this file is
   no longer needed and can be removed." It dates from 2026-03-24 and contains a
   hardcoded local path (`/Users/vaidehi/projects/recruiting/`). Delete it.
2. **`vagarwalla/infra` does not appear in the account's repo list.** Both
   `scaffold/CLAUDE.md` and `scaffold/README.md` name it as the single source of truth
   for global config. Either it was never created or it is not reachable from this
   account. Worth confirming before we point earmarked at it — see Phase 4.

## Plan

Ordered so the highest-value, lowest-risk work lands first. Phases 1–3 are safe to do
in one pass; Phase 4 needs a decision from you.

### Phase 1 — Add `CLAUDE.md` (the main deliverable)

Create `CLAUDE.md` at the repo root, following the scaffold's section order exactly so
the two files stay diffable as the template evolves. Content drafted below in
[Appendix A](#appendix-a--drafted-claudemd). Sourcing:

- Architecture, versions → `package.json`
- Supabase project ref `xkwiugwafgcmcwlyzawq` → `supabase/.temp/project-ref`, `src/lib/migrate.ts`
- Tables → `supabase/schema.sql` + `supabase/migrations/00{1..8}_*.sql`
- Env vars → `grep -roE 'process\.env\.[A-Z0-9_]+' src scripts`
- Key decisions → `README.md` naming section, `docs/OPTIMIZER_IMPROVEMENT_PLAN.md`

**Done when:** `CLAUDE.md` exists with all eight scaffold sections filled with
earmarked-specific facts (no placeholder text carried over from the template).

### Phase 2 — Fix the broken onboarding path

Add `.env.example` covering all seven variables the code actually reads, with the two
Supabase vars matching scaffold's format and the rest commented as optional:

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
# Optional — AI edition grouping
ANTHROPIC_API_KEY=
NEXT_PUBLIC_AI_GROUPING=
# Optional — richer edition metadata
GOOGLE_BOOKS_API_KEY=
# Optional — only for src/lib/migrate.ts (applies SQL via the Management API)
SUPABASE_ACCESS_TOKEN=
```

`.gitignore` currently has a blanket `.env*`, which would swallow this file — add a
`!.env.example` negation (scaffold's `.gitignore` handles this already).

**Done when:** a clean clone can follow `README.md`'s setup steps without hitting a
missing file, and `git status` shows `.env.example` as tracked.

### Phase 3 — Adopt the scaffold's DONE contract and knowledge-capture layout

- **DONE signal.** Write earmarked's stack-specific version into `CLAUDE.md`: `npm run
  build` exits 0, `npm run lint` clean, `npm test` green, and — for any change under
  `src/lib/optimizer/` — `npm run bench:optimizer` stays inside the 250ms envelope.
  That last clause is a genuine improvement on the scaffold default and is the kind of
  thing the scaffold asks projects to push back upstream.
- **`docs/solutions/`.** Create the directory and migrate the reusable scraper findings
  out of `overnight-logs/SESSION_NOTES.md` — the ThriftBooks `/browse/?b.search={isbn}`
  redirect trick and the BWB block are exactly the "solved once, hard to rediscover"
  knowledge the convention exists for. One file, frontmatter per the scaffold example,
  `category: scraping`. Leave `overnight-logs/` in place as a raw session log.
- Delete `MIGRATION_NOTICE.md`.

**Done when:** `CLAUDE.md` carries the DONE section, `docs/solutions/scraping/` has the
migrated note with valid frontmatter, and `MIGRATION_NOTICE.md` is gone.

### Phase 4 — Reconcile the infra pointer (needs a decision)

`CLAUDE.md`'s "Infra & global config" section is supposed to point at `vagarwalla/infra`,
which I could not find in the account's repositories. Options:

1. **Point at it anyway** — correct if the repo exists but isn't visible to this session.
2. **Point at `vagarwalla/scaffold`** — accurate today, since scaffold is where the
   template and the one `docs/solutions/` note actually live.
3. **Create `vagarwalla/infra`** and seed it with what's currently implicit: the shared
   Supabase project ref, the Namecheap → Vercel CNAME runbook from scaffold's README,
   and the subdomain conventions.

Recommendation: **(1)** if the repo exists, otherwise **(3)** — scaffold already commits
to `infra` being the source of truth in two places, so making it real is cheaper than
unwinding the reference across every project generated from the template.

Also unresolved by the same token: earmarked's production hostname. If there is a
`*.vaidehiagarwalla.com` subdomain for it, the `CLAUDE.md` title line should carry it;
if it lives on a default `*.vercel.app` URL, say that instead.

### Explicitly out of scope

- Renaming `src/components/providers.tsx` → `Providers.tsx` to match scaffold casing.
  Cosmetic, and case-only renames are hostile on macOS checkouts.
- Reconciling `src/app/globals.css` with scaffold's design tokens. earmarked has its own
  established look; the scaffold palette is a starting point, not a standard.
- Any change to `/api/cart/*` routes, TS types, or the DB schema. The README's rename
  rule stands and Phase 1 promotes it into `CLAUDE.md` rather than acting on it.

## Appendix A — drafted `CLAUDE.md`

```markdown
# Earmarked — <domain TBD, see Phase 4>

Find cheap used books and minimize shipping costs. Build a stack of books, pick
editions, and Earmarked finds the cheapest way to buy them all by grouping sellers.

## Architecture
- **Framework**: Next.js 16.1.6 (App Router) with TypeScript + Tailwind CSS v4, React 19.2
- **UI**: shadcn/ui + Base UI, `next-themes` dark/light, `sonner` toasts
- **Backend**: Supabase (shared project `xkwiugwafgcmcwlyzawq` / `bookbundle`)
- **Scraping**: `playwright-core` + `@sparticuz/chromium` running inside Vercel functions
- **AI**: `@anthropic-ai/sdk` for edition grouping (behind `NEXT_PUBLIC_AI_GROUPING`)
- **Hosting**: Vercel; `vercel.json` raises `maxDuration` on the scraping routes
  (`prices`, `cover-hashes`, `cover-groups` to 60s; `popularity` to 30s)
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
- The optimizer is **deterministic** — seeded RNG, byte-identical results across runs.
  Determinism is a prerequisite for the test suite; don't introduce unseeded randomness.
- Optimizer strategies live behind one entry point (`src/lib/optimizer/index.ts`):
  greedy, exact, local-search, and a combined warm-start. Exact search is node-capped.
- Listings are scraped directly from ThriftBooks and Better World Books (BookFinder was
  replaced in March 2026); AbeBooks has its own condition-group handling.
- Quantity buys distinct copies — per-listing stock is modeled, not assumed infinite.
- Light/dark mode with theme toggle (next-themes), preference stored in localStorage.

## Database Schema
Source of truth is `supabase/schema.sql` plus `supabase/migrations/001..008`. Apply
migrations with `src/lib/migrate.ts` (needs `SUPABASE_ACCESS_TOKEN`).

## Environment Variables
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key
- `ANTHROPIC_API_KEY` — optional; AI edition grouping
- `NEXT_PUBLIC_AI_GROUPING` — optional; feature flag for AI grouping
- `GOOGLE_BOOKS_API_KEY` — optional; supplementary edition metadata
- `SUPABASE_ACCESS_TOKEN` — optional; only for `src/lib/migrate.ts`

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
- `src/components/` — React components
- `docs/solutions/` — reusable findings (see scaffold convention)

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

If this project introduces anything infra-level (a new subdomain, a Supabase table
convention, an env-var pattern, a deploy quirk, a reusable script), record it in
`vagarwalla/infra` — not only here.
```

## Appendix B — candidate upstream contributions

Things earmarked already does better than the template, worth pushing back to
`vagarwalla/scaffold`:

- **A test script in the DONE signal.** Scaffold's default DONE has no `npm test` because
  scaffold ships no test setup. Adding Vitest + a `test` script to the template would
  make the DONE contract meaningful from day one in every generated project.
- **Performance-envelope DONE clauses.** The `bench:optimizer` pattern (a benchmark that
  fails outside a fixed time envelope) generalizes as an optional DONE clause.
- **`vercel.json` `maxDuration` guidance.** Any scaffold project doing scraping or AI
  calls will hit the default function timeout; the template says nothing about it.
