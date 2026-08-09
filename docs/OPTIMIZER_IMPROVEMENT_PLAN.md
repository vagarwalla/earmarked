# Optimizer Review & Improvement Plan

**Revision 2.**
Revision log:
- *Rev 1*: findings empirically verified with probe code; withdrew rev 0's
  unsafe suggestion to raise the exact strategy's candidate cap (10¹² worst
  case); added compute-budget envelope, node cap, and batch-endpoint finding.
- *Rev 2*: double-checked rev 1's own solutions. Replaced "run exact and
  local search, take the min" with the cheaper and stronger warm-start
  design; reordered phases (determinism is a prerequisite for deterministic
  exact search); corrected two proposed test invariants that don't hold for
  heuristics; turned the combined-vs-single-source invariant into a
  code-level guarantee; decomposed the work into PR-sized units with
  acceptance criteria.

The core algorithm of Earmarked is the seller-grouping optimizer
(`src/lib/optimizer/`): given a stack of books and live listings, it assigns
each book to a seller so that the total of prices + bundled shipping is
minimized. Pipeline:

```
buildBookOptions (filter + sort)          src/lib/optimizer/shared.ts
  → strategy.solve()                      exact (≤12 books) | local-search (>12)
  → buildGroups + totals                  src/lib/optimizer/index.ts
```

The overall design is sound — incremental cost tracking (`CostTracker`),
branch-and-bound with a valid lower bound, multi-start greedy + iterated
local search — and 96 optimizer-related tests pass. Findings marked
**[verified]** were reproduced with probe code against the current
implementation.

## Findings

### F1. "Exact" is not exact, and loses to local search today [verified]

`exact.ts` caps candidates at `MAX_CANDIDATES_PER_BOOK = 6` sellers per book,
chosen by cheapest standalone price. A seller that is slightly pricier per
book but covers *many* books (the consolidation winner) can be truncated
away. Probe: 10 books, each with 6 distinct cheap single-book sellers plus
one seller "Z" carrying everything at 7th-cheapest price — **exact returned
$49.90 while local search found the $41.90 optimum** (19% worse). Nothing
cross-checks the strategies, so the auto-selection rule (`≤12 books → exact`)
actively picks the worse answer on this shape of cart.

### F2. Exact has no runtime guard and blows up adversarially [verified]

Branch-and-bound worst case is `candidates^books` (6¹² ≈ 2.2 × 10⁹ nodes).
The lower bound prunes well when prices differ, but when many sellers carry
the same books at near-identical prices the bound is weak. Probe: 12 books ×
6 full-coverage sellers with prices within $0.05 of each other → **4,991ms**;
a 10-book × 7-seller variant took ~9s. No node cap, no deadline, no fallback
— a plausible cart shape (popular books, many big sellers) can hang
`/api/optimize` into a serverless timeout.

### F3. Filter semantics diverge between optimizer and relaxation

Per `types.ts`, `signed_only: false` means "exclude signed". The optimizer's
`buildBookOptions` implements that. But `relaxation.ts#computeListings` uses
`(!item.signed_only || l.signed)`, which treats `false` as "any" — same for
`first_edition_only` and `dust_jacket_only`. The Find Deals panel and the
optimizer therefore disagree about which listings qualify. Root cause: two
independent implementations of "does this listing qualify".

### F4. Books with no qualifying listings vanish silently

An item whose listings are all filtered out produces no assignment and no
trace in `OptimizationResult`; `grand_total` looks like the cost of the
whole stack when it only covers part of it.

### F5. `quantity > 1` assumes a used listing has unlimited stock

All strategies multiply one listing's price by `item.quantity`; used-book
listings are usually single copies, so the produced plan can be unbuyable.
Additionally `naive_total` charges `(price + shipping_base) × quantity` —
full base shipping per unit — inflating advertised savings.

### F6. Non-deterministic results; ILS budget misallocated

`local-search.ts` uses raw `Math.random()` and a wall-clock deadline, so the
same cart can return different groupings on consecutive runs, and quality
regressions can't be asserted in tests. The deadline is computed once before
the multi-start loop: start 0's ILS loop runs until it expires, so starts
1–4 get greedy + one improvement pass and **zero** ILS iterations. (The
2-swap pass has no deadline check either, though measured sweep cost — ~45k
O(1) tracker operations at n=30 — makes that minor in practice.)

### F7. The UI computes the same optimization twice, via five API calls [verified]

`OptimizationPanel.filterBySource` returns the *identical* listings map for
`'best'` and `'combined'`, and `updateAllResults` fires five parallel
`/api/optimize` calls per search. Two of the five are byte-identical work,
all five re-run listing qualification from scratch on overlapping data, and
the full listings map is uploaded five times. ~40% of per-search optimizer
compute and payload is redundant.

### F8. Unvalidated input at the API boundary

`/api/optimize` destructures `req.json()` straight into the optimizer. A
malformed body throws mid-algorithm as an opaque 500; non-finite prices
would silently corrupt cost comparisons. (`zod` is **not** currently a
dependency — validation needs either a new dep or a hand-rolled guard.)

### F9. Minor internal inconsistencies

- `buildGroups` recomputes shipping from `assignments[0]`'s params with
  hardcoded `3.99/1.99` fallbacks, independently of the cost the strategy
  optimized — two sources of truth for the same number.
- `exact.ts` picks candidates in `price + shipping_base` order but re-sorts
  by bare `price`.
- Greedy's inner loop does `bookOptions.find(...)` and
  `Array.from(unassigned).filter(...)` per seller per round — O(n² · sellers)
  per pass; fine today, a cliff for large stacks.
- `CartItem.format` and `flexible` are ignored by the optimizer (format is
  enforced upstream via edition/ISBN selection — should be documented or
  asserted, not implicit).

### F10. Test gaps

Good example-based coverage, but nothing that would catch a quality or
runtime regression: no randomized/property tests, no brute-force oracle, no
adversarial-runtime test, no determinism assertion, no benchmark.

## Target compute envelope

One optimize request: **p95 < 250ms, hard worst case < 1s, fully
deterministic.** Current worst case is unbounded (F2). Allocation:

| Component | Budget | Mechanism |
|---|---|---|
| listing qualification | O(listings), once per request | qualify once, partition per source (F7 fix) |
| local search (always runs) | fixed iteration count | seeded PRNG + per-start ILS iteration budget |
| exact refinement (when gated in) | ≤ ~500k nodes ≈ 50–100ms | warm start + node cap + ordering (below) |

**Solve order (replaces `≤12 books → exact`):**

1. Always run seeded local search first — cheap, bounded, deterministic.
2. Gate exact refinement on a branching estimate
   (Σ log candidateCount_i ≲ log 10⁷): small/sparse carts qualify even with
   >12 books; dense adversarial carts skip straight to the LS answer.
3. When exact runs, it is **warm-started with the LS assignment as the
   initial incumbent** (`bestCost` = LS cost). This is strictly better than
   rev 1's "run both, take min": the search prunes far harder from node one
   (upper bound is tight immediately), a node-cap abort still returns
   something ≥ LS quality *by construction*, and there is one code path
   instead of a comparison step.
4. Node cap (counted nodes, not wall clock — deterministic) aborts pathological
   searches; the incumbent at abort is the answer.

Note the dependency this creates: exact's output is only deterministic if
its warm start is, so seeding local search (F6) must land **before or with**
the exact rework — reflected in the PR order below.

## Plan

### Workstream A — Correctness at the boundaries (F3, F4, F5-savings)

1. Extract a single `listingQualifies(item, listing, conditions, maxPrice)`
   into `shared.ts`; use it from `buildBookOptions` and `relaxation.ts`; fix
   relaxation's tri-state boolean handling to match `types.ts`.
2. Add `unassigned: CartItem[]` to `OptimizationResult`; populate in
   `optimize()`; render in `OptimizationPanel`.
3. Fix `naive_total`: one naive order per book =
   `price × qty + shippingCost(qty, base, perAdditional)`.

### Workstream B — Determinism (F6) *(prerequisite for C)*

4. Thread a seeded PRNG (mulberry32) through `solveGreedy` and `perturb`;
   seed = stable hash of the input. Identical requests → identical answers
   (also enables response memoization by input hash later).
5. Replace the shared wall-clock deadline with per-start ILS iteration
   budgets (keep one global wall-clock cap only as a serverless backstop);
   add the budget check to the 2-swap loop.

### Workstream C — Bound and strengthen exact search (F1, F2)

6. Implement the solve order from the envelope section: LS-first,
   branching-estimate gate, warm-started branch-and-bound, node cap with
   incumbent return.
7. Zero-cost pruning wins: order books most-constrained-first (fewest
   candidates, then largest price spread) before branching; sort candidates
   by `price + shipping_base` consistently.
8. Candidate quality (keep cap at 6 — raising it is what rev 0 got wrong):
   build each book's candidate list as ~4 cheapest sellers + ~2
   highest-cart-coverage sellers. With warm start this is purely a quality
   improvement — correctness no longer depends on the candidate set.

### Workstream D — API efficiency and hardening (F7, F8)

9. Batch endpoint: `/api/optimize` accepts the listings map once plus
   requested sources, returns `{ best, abe, thriftbooks, bwb, combined }`.
   Server qualifies listings once and partitions by seller source; `best`
   aliases `combined`. Payload uploaded once instead of five times. Sole
   client is `OptimizationPanel.updateAllResults`.
10. In the batch handler, enforce `combined ≤ min(single-source results)` in
    code: every single-source assignment is feasible in the combined space,
    so if a heuristic run of combined comes out worse, adopt the better
    single-source assignment. (Rev 1 proposed asserting this as a test
    invariant — that's wrong for heuristics in general; as a code-level min
    over already-computed results it costs nothing and makes the invariant
    true, so the test may then assert it strictly.)
11. Validate input with a hand-rolled guard (~40 lines: array shapes, finite
    numbers, string ids) returning 400 with a message; cap payload size.
    Swap for zod only if the project adopts it more broadly.

### Workstream E — Model fidelity (F5, F9)

12. Real quantity handling: a seller's offer for a book = its k cheapest
    distinct listings; `quantity: n` costs the sum of the n cheapest copies
    (unfulfillable at sellers with fewer). Candidate entries become
    `{sellerId, listings, totalPrice}` so `CostTracker` stays O(1).
    **Note:** `SellerGroup.assignments[].listing` becomes `listings[]` — a
    breaking type change that reaches `OptimizationPanel` rendering; this is
    why E is its own PR.
13. Derive `SellerGroup.shipping`/`group_total` from the same seller-state
    computation `computeTotalCost` uses; drop the hardcoded fallbacks.
14. Precompute `itemId → BookOption` and `seller → uncovered items` maps in
    greedy (removes the O(n²·sellers) inner `find`s).

### Workstream F — Verification infrastructure (F10)

15. Property-based tests with a seeded instance generator:
    - **Oracle**: n ≤ 6 books, ≤ 5 sellers → enumerate all ≤ 5⁶ ≈ 15.6k
      assignments (no candidate cap); `optimize()` must match the optimum.
      Monotonicity ("adding a listing never increases cost") is asserted
      **against the oracle only** — it does not hold for heuristic paths
      (rev 1 had this wrong).
    - Dominance: `optimize()` cost ≤ greedy cost; combined ≤ each
      single-source (guaranteed by step 10).
    - Invariants: every assigned listing passes `listingQualifies`; group
      totals sum to `grand_total`; `savings ≥ 0`; `unassigned` ∪ assigned =
      all items.
    - Determinism: same input twice → identical result.
    - Adversarial regressions from the probes: 12×6 near-identical cart
      completes under the node cap in bounded time; consolidation cart
      reaches $41.90.
16. `npm run bench:optimizer`: 5/15/30/60 books × varying seller overlap;
    reports cost gap vs best-known and p95 latency; run when tuning
    constants.

## PR decomposition

Ordered so each PR is independently shippable, verified by its own tests,
and no PR depends on a later one:

| PR | Contents | Size | Acceptance criteria |
|---|---|---|---|
| 1 | Workstream A | S | new filter-semantics tests pass in both call sites; `unassigned` populated; savings math test updated |
| 2 | Workstream B | S | same-input-twice equality test; all existing quality tests still green; ILS iterations observed per start |
| 3 | Workstream C + F15 oracle & adversarial tests | M | consolidation cart returns $41.90; 12×6 adversarial cart < 200ms; oracle equality on n ≤ 6; node cap covered by test |
| 4 | Workstream D | M | one request per Find Deals; `best` === `combined` object; combined ≤ single-source enforced; 400 on malformed body |
| 5 | Workstream E (+ UI updates) | M/L | qty-2 cart uses two distinct listings; group totals derived from `computeTotalCost`; UI renders multi-listing assignments |
| 6 | Workstream F remainder (generator invariants, bench) | S/M | property suite in CI; bench script documented |

PRs 1 and 2 are independent and can land in either order; PR 3 requires
PR 2 (deterministic warm start). PR 3 fixes both measured defects (wrong
answer + 5s hang) and is the payoff milestone; PRs 4–6 are efficiency,
fidelity, and lock-in.
