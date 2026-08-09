# Optimizer Review & Improvement Plan

**Revision 1** — findings empirically verified against the live code; solutions
re-checked for compute cost; one original recommendation (raising the exact
strategy's candidate cap) withdrawn as unsafe and replaced.

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
search — and 96 optimizer-related tests pass. The issues below are ordered by
impact. Findings marked **[verified]** were reproduced with probe code against
the current implementation.

## Findings

### F1. "Exact" is not exact, and loses to local search today [verified]

`exact.ts` caps candidates at `MAX_CANDIDATES_PER_BOOK = 6` sellers per book,
chosen by cheapest standalone price. A seller that is slightly pricier per
book but covers *many* books (the consolidation winner) can be truncated away.
Probe: 10 books, each with 6 distinct cheap single-book sellers plus one
seller "Z" carrying everything at 7th-cheapest price — **exact returned
$49.90 while local search found the $41.90 optimum** (19% worse). Nothing
cross-checks the two strategies, so the auto-selection rule (`≤12 books →
exact`) actively picks the worse answer on this shape of cart.

### F2. Exact has no runtime guard and blows up adversarially [verified]

Branch-and-bound worst case is `candidates^books` (6¹² ≈ 2.2 × 10⁹ nodes).
The lower bound prunes well when prices differ, but when many sellers carry
the same books at near-identical prices the bound is weak. Probe: 12 books ×
6 full-coverage sellers with prices within $0.05 of each other → **4,991ms**;
a 10-book × 7-seller variant took ~9s. There is no node cap, no deadline, and
no fallback — a plausible cart shape (popular books, many big sellers) can
hang the `/api/optimize` route into a serverless timeout.

### F3. Filter semantics diverge between optimizer and relaxation

Per `types.ts`, `signed_only: false` means "exclude signed". The optimizer's
`buildBookOptions` implements that. But `relaxation.ts#computeListings` uses
`(!item.signed_only || l.signed)`, which treats `false` as "any" — same for
`first_edition_only` and `dust_jacket_only`. The Find Deals panel and the
optimizer therefore disagree about which listings qualify. Root cause: two
independent implementations of "does this listing qualify".

### F4. Books with no qualifying listings vanish silently

An item whose listings are all filtered out produces no assignment and no
trace in `OptimizationResult`; `grand_total` looks like the cost of the whole
stack when it only covers part of it.

### F5. `quantity > 1` assumes a used listing has unlimited stock

All strategies multiply one listing's price by `item.quantity`; used-book
listings are usually single copies, so the produced plan can be unbuyable.
Additionally `naive_total` charges `(price + shipping_base) × quantity` —
full base shipping per unit — inflating advertised savings.

### F6. Non-deterministic results; ILS budget misallocated

`local-search.ts` uses raw `Math.random()` and a wall-clock deadline, so the
same cart can return different groupings on consecutive runs, and quality
regressions can't be asserted in tests. The deadline is computed once before
the multi-start loop: start 0's ILS loop runs until it expires, so starts 1–4
get greedy + one improvement pass and **zero** ILS iterations. (The 2-swap
pass has no deadline check either, though measured sweep cost — ~45k O(1)
tracker operations at n=30 — makes that a minor concern in practice.)

### F7. The UI computes the same optimization twice, via five API calls [verified]

`OptimizationPanel.filterBySource` returns the *identical* listings map for
`'best'` and `'combined'`, and `updateAllResults` fires five parallel
`/api/optimize` calls per search. Two of the five are byte-identical work,
and all five re-run `buildBookOptions` filtering from scratch on overlapping
data. ~40% of per-search optimizer compute (and network payload — the full
listings map is re-uploaded five times) is redundant.

### F8. Unvalidated input at the API boundary

`/api/optimize` destructures `req.json()` straight into the optimizer. A
malformed body throws mid-algorithm as an opaque 500; non-finite prices would
silently corrupt cost comparisons. (Note: `zod` is **not** currently a
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
- (Withdrawn from rev 0: cross-ISBN listing duplication in
  `buildBookOptions` — candidate ISBNs are already Set-deduped and listings
  are keyed by ISBN, so duplicates can't actually arise.)

### F10. Test gaps

Good example-based coverage, but nothing that would catch a quality or
runtime regression: no randomized/property tests, no brute-force oracle, no
adversarial-runtime test, no determinism assertion, no benchmark.

## Compute budget (target envelope)

Design target for one optimize call: **p95 < 250ms, hard worst case < 1s**,
deterministic. Current worst case is unbounded (F2). The budget allocation
that achieves this:

| Component | Budget | Mechanism |
|---|---|---|
| buildBookOptions | O(listings) | shared once per request across sources (F7 fix) |
| exact strategy | ≤ ~500k nodes | explicit node cap + adaptive opt-in (below) |
| local search | fixed iteration count | per-start ILS iteration budget, seeded PRNG |
| safety-net LS after exact | ≤ 50ms | reuses existing LS with small budget |

**Adaptive strategy selection** replaces the blunt `≤12 books → exact` rule:
estimate branching as Σ log(candidateCount_i); run exact only when the
estimate fits the node budget (with the node cap as backstop), otherwise go
straight to local search. This is simultaneously safer (F2) and less
conservative — a 20-book cart where most books have 1–2 sellers is cheap to
solve exactly and currently never gets the chance.

## Plan

### Phase 1 — Correctness at the boundaries (small diffs, high impact)

1. **Single qualification function.** Extract `listingQualifies(item, listing,
   conditions, maxPrice)` into `shared.ts`; use it from both
   `buildBookOptions` and `relaxation.ts`; fix relaxation's tri-state boolean
   handling to match `types.ts` (F3). Tests for `false` = exclude on all
   three flags, in both call sites.
2. **Surface unassigned books.** Add `unassigned: CartItem[]` to
   `OptimizationResult`; populate in `optimize()`; render in
   `OptimizationPanel` (F4).
3. **Fix `naive_total` for quantity**: one naive order per book =
   `price × qty + shippingCost(qty, base, perAdditional)` (F5, savings part).

### Phase 2 — Bound and harden the exact strategy (F1, F2)

4. **Node cap with graceful degradation.** Count explored nodes; at the cap
   (deterministic, not wall-clock), stop and return the best incumbent found
   so far. `optimize()` then polishes/cross-checks with local search (step 6),
   so a capped run degrades to "very good" instead of "hung".
5. **Better pruning at zero cost.** Order books most-constrained-first
   (fewest candidates, then largest price spread) before branching — standard
   variable-ordering, typically cuts nodes by orders of magnitude on exactly
   the adversarial shapes measured in F2. Fix the candidate sort to use
   `price + shipping_base` consistently.
6. **Cross-check, don't trust.** Keep `MAX_CANDIDATES_PER_BOOK = 6` (do
   **not** raise it — rev 0 of this plan suggested 10, which makes the F2
   worst case ~10¹² nodes; withdrawn). Instead: (a) build each book's
   candidate list as ~4 cheapest sellers + ~2 highest-cart-coverage sellers,
   which is what the truncation probe shows exact actually misses; (b) in
   `optimize()`, when exact ran, also run local search (≤50ms at these sizes)
   and return whichever assignment `computeTotalCost` scores lower. Result is
   provably ≥ as good as today's local search on every cart.
7. **Adaptive strategy selection** per the compute-budget section: replace
   `EXACT_BOOK_LIMIT` with a branching estimate against the node budget.

### Phase 3 — Determinism (F6)

8. **Seeded PRNG.** Thread mulberry32 (or similar) through
   `solveGreedy(randomness)` and `perturb`; seed derived from a stable hash of
   the input so identical requests give identical answers. This also makes
   responses memoizable/cacheable by input hash if wanted later.
9. **Iteration-based budgets.** Per-start ILS iteration counts instead of one
   shared wall-clock deadline (keep a global wall-clock cap only as a
   serverless backstop); budget check inside the 2-swap loop.

### Phase 4 — Stop duplicating work at the API (F7, F8)

10. **Batch endpoint.** Change `/api/optimize` to accept the listings map
    once plus a list of source filters, returning
    `{ best, abe, thriftbooks, bwb, combined }` in one response: the server
    filters per source itself, `best` aliases `combined`'s computation, and
    the listings payload is uploaded once instead of five times. Sole client
    is `OptimizationPanel.updateAllResults`, so the shape change is contained.
11. **Validate input.** Hand-rolled type guard (~40 lines: items array shape,
    finite numbers for price/shipping/quantity, string ids) returning 400
    with a message — avoids adding a dependency; swap for zod if the project
    adopts it elsewhere. Cap accepted payload size.

### Phase 5 — Model fidelity (F5)

12. **Real quantity handling.** Represent a seller's offer for a book as its
    k cheapest distinct listings; for `quantity: n`, cost = sum of the n
    cheapest copies (unfulfillable at sellers with fewer than n copies).
    Candidate entries become `{sellerId, listings, totalPrice}` so
    `CostTracker` calls stay O(1). Touches `buildBookOptions`, all three
    strategies, `buildGroups`.
13. **One source of truth for totals.** Derive `SellerGroup.shipping` /
    `group_total` from the same seller-state computation `computeTotalCost`
    uses (F9).

### Phase 6 — Verification infrastructure (locks it all in)

14. **Property-based tests** with a seeded random instance generator:
    - brute-force oracle: for n ≤ 6 books and ≤ 5 sellers, enumerate all
      assignments (no candidate cap; ≤ 5⁶ ≈ 15.6k states) and assert the
      shipped optimizer matches the optimum;
    - dominance: local-search cost ≤ greedy cost; `optimize()` cost ≤ both;
      combined-source result ≤ every single-source result;
    - invariants: every assigned listing passes `listingQualifies`; group
      totals sum to `grand_total`; `savings ≥ 0`; adding a listing never
      increases the optimal cost;
    - determinism: same input → identical result twice;
    - **adversarial regression tests** from the F1/F2 probes: the 12×6
      near-identical-prices cart must finish under the node cap in bounded
      time, and the consolidation-seller cart must reach $41.90.
15. **Benchmark script** (`npm run bench:optimizer`) over realistic sizes
    (5/15/30/60 books, varying seller overlap) reporting cost gap vs
    best-known and p95 latency, run when tuning constants.

### Suggested order

Phase 2 is now the highest-priority work (it fixes a measured wrong answer
and a measured 5s hang); Phase 1 remains the cheapest. Land the Phase 6
oracle + adversarial tests together with Phase 2 so the fixes are verified by
the same probes that exposed them. Phase 5 step 12 is the only change that
touches every strategy and should be its own PR.
