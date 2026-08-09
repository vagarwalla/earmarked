# Optimizer Review & Improvement Plan

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
branch-and-bound with a valid lower bound, multi-start greedy + iterated local
search — and 96 optimizer-related tests pass. The issues below are about
robustness and reliability, ordered by impact.

## Findings

### F1. "Exact" is not exact, and can lose to local search (correctness)

`exact.ts` caps candidates at `MAX_CANDIDATES_PER_BOOK = 6` sellers per book,
chosen by cheapest standalone price. A seller that is slightly pricier per
book but covers *many* books in the cart (the consolidation winner) can be
truncated away, so branch-and-bound optimizes over the wrong space.
Meanwhile `local-search.ts` uses 10 candidates per book — so for carts of
≤12 books the auto-selected "exact" strategy can return a strictly worse
answer than local search would have. Nothing cross-checks the two.

### F2. Filter semantics diverge between optimizer and relaxation (correctness)

Per `types.ts`, `signed_only: false` means "exclude signed". The optimizer's
`buildBookOptions` implements that. But `relaxation.ts#computeListings` uses
`(!item.signed_only || l.signed)`, which treats `false` as "any" — same for
`first_edition_only` and `dust_jacket_only`. The Find Deals panel and the
optimizer therefore disagree about which listings qualify, producing
suggestions the optimizer will refuse (or vice versa). Two independent
implementations of "does this listing qualify" is the root cause.

### F3. Books with no qualifying listings vanish silently (reliability)

An item whose listings are all filtered out simply produces no assignment;
`OptimizationResult` has no record of it. `grand_total` then looks like the
cost of the whole stack when it only covers part of it. The result should
explicitly return unassigned items so the UI can say "3 of 4 books found".

### F4. `quantity > 1` assumes a used listing has unlimited stock (correctness)

All strategies multiply one listing's price by `item.quantity`. Used-book
listings (especially AbeBooks) are usually single copies, so the plan the
optimizer produces can be unbuyable. Also, `naive_total` charges
`(price + shipping_base) × quantity` — counting full base shipping per unit —
which inflates the advertised "savings".

### F5. Non-deterministic results (reliability/testability)

`local-search.ts` uses raw `Math.random()` and a wall-clock `Date.now()`
deadline. The same cart with the same listings can return different groupings
on consecutive runs (the UI fires 5 optimize calls per search — one per
source tab — so inconsistency is visible). It also makes quality regressions
impossible to assert in tests. Related: the deadline is computed once, and
the first start's ILS loop runs until it expires, so starts 2–5 get greedy +
one local-search pass but **zero** ILS time; and the 2-swap pass has no
deadline check at all, so it can overshoot the budget on ~30-book carts with
many sellers.

### F6. Unvalidated input at the API boundary (robustness)

`/api/optimize` destructures `req.json()` straight into the optimizer. A
malformed body (items not an array, listings missing numeric fields) throws
mid-algorithm and surfaces as an opaque 500. `NaN` prices would silently
corrupt cost comparisons.

### F7. Minor internal inconsistencies

- `buildBookOptions` does not dedupe listings that appear under multiple
  candidate ISBNs (`relaxation.ts` dedupes by `listing_id`).
- `buildGroups` recomputes shipping from `assignments[0]`'s params with
  hardcoded `3.99/1.99` fallbacks, independently of the cost the strategy
  optimized — two sources of truth for the same number.
- `exact.ts` picks candidates in `price + shipping_base` order but then
  re-sorts by bare `price`.
- Greedy's inner loop does `bookOptions.find(...)` and
  `Array.from(unassigned).filter(...)` per seller per round — O(n²·sellers);
  fine today, a cliff for large stacks.
- `CartItem.format` and `flexible` are ignored by the optimizer (format is
  presumably enforced upstream via edition/ISBN selection — worth documenting
  or asserting).

### F8. Test gaps

Good example-based coverage, but nothing that would catch a quality
regression: no randomized/property tests, no brute-force oracle, no
determinism assertion, no benchmark.

## Plan

### Phase 1 — Correctness (small diffs, high impact)

1. **Single qualification function.** Extract `listingQualifies(item, listing,
   conditions, maxPrice)` into `shared.ts`; use it from both
   `buildBookOptions` and `relaxation.ts`. Fix the tri-state boolean handling
   in relaxation to match `types.ts` (F2). Add tests for `false` = exclude on
   all three flags, in both call sites.
2. **Surface unassigned books.** Add `unassigned: CartItem[]` to
   `OptimizationResult`; populate in `optimize()`; render in
   `OptimizationPanel` (F3).
3. **Strategy safety net.** In `optimize()`, when the exact strategy is used,
   also run local search and keep whichever assignment scores lower with
   `computeTotalCost`. Cheap (exact carts are ≤12 books) and makes the
   auto-selection monotone: never worse than local search (F1). Also raise
   exact's candidate cap to match local search (10) and add coverage-aware
   candidate selection: always include the K sellers with the largest cart
   coverage in each book's candidate list even if not among its cheapest.
4. **Fix `naive_total` for quantity.** One naive order per book:
   `price × qty + shippingCost(qty, base, perAdditional)` (F4, savings part).

### Phase 2 — Determinism & budgets

5. **Seeded PRNG.** Thread a small PRNG (e.g. mulberry32) through
   `solveGreedy(randomness)` and `perturb`; default to a fixed seed derived
   from the input so identical requests give identical answers (F5).
6. **Iteration-based budgets.** Replace the single wall-clock deadline with a
   per-start ILS iteration budget (keep a global wall-clock cap as a backstop);
   add a budget check inside the 2-swap loops. Tests can then assert exact
   search behavior without timing flakiness.

### Phase 3 — Model fidelity

7. **Real quantity handling.** In candidate construction, represent a seller's
   offer for a book as its k cheapest distinct listings; for `quantity: n`,
   cost = sum of the n cheapest copies from that seller (marking the book
   unfulfillable at sellers with fewer than n copies). Touches
   `buildBookOptions`, all three strategies, and `buildGroups` (F4).
8. **One source of truth for totals.** Derive `SellerGroup.shipping` and
   `group_total` from the same seller-state computation `computeTotalCost`
   uses, and dedupe listings by `listing_id` in `buildBookOptions` (F7).

### Phase 4 — Boundary hardening & performance

9. **Validate `/api/optimize`** (and reuse for `/api/prices` consumers): zod
   schema for items + listings, finite-number checks on price/shipping,
   reject with 400 + message; cap payload size (F6).
10. **Greedy performance pass.** Precompute `itemId → BookOption` and
    `seller → uncovered item ids` maps so each round is O(sellers + n) instead
    of O(sellers × n) with embedded `find`s (F7).

### Phase 5 — Verification infrastructure (locks it all in)

11. **Property-based tests** with a random instance generator (books ×
    sellers × price/shipping distributions, seeded):
    - brute-force oracle: for n ≤ 6 books, enumerate *all* assignments
      (no candidate cap) and assert the shipped optimizer matches the optimum;
    - dominance: local-search cost ≤ greedy cost; combined result ≤ every
      single-source result;
    - invariants: every assigned listing passes `listingQualifies`; group
      totals sum to `grand_total`; `savings = naive − grand ≥ 0`; adding a
      listing never increases the optimal cost;
    - determinism: same input → identical result twice.
12. **Benchmark script** (`npm run bench:optimizer`) over realistic sizes
    (5/15/30/60 books, varying seller overlap) reporting cost gap vs
    brute-force/best-known and p95 latency, to catch quality or latency
    regressions when tuning constants.

### Suggested order & scope

Phases 1–2 are the "robust and reliable" core (roughly a day of work,
mostly small diffs + tests). Phase 5's oracle test is worth pulling forward
to land alongside Phase 1, since it will immediately re-verify F1/F3 fixes.
Phases 3–4 are meaningful but larger; Phase 3 step 7 is the only change that
touches every strategy and should be its own PR.
