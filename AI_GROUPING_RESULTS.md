# AI Edition Grouping Experiment Results

**Date:** 2026-03-12

## Summary

| Book | Editions | Heuristic Groups | AI Groups | Heuristic Score | AI Score | Improvement |
|------|----------|-----------------|-----------|-----------------|----------|-------------|
| To Kill a Mockingbird | 4 | 3 | 3 | 100 | 100 | 0 \* |
| 1984 | 4 | 3 | 3 | 100 | 100 | 0 \* |
| The Great Gatsby | 4 | 3 | 3 | 100 | 100 | 0 \* |

**Average improvement:** 0.0 points

\* Used fallback/sample data (dev server unavailable during experiment)

## Verdict

VERDICT: AI improvement (0.0 pts) does not exceed 10-point threshold. Heuristics are sufficient.

## Methodology

- **Heuristic grouper:** `groupEditionsByCover()` in `EditionPicker.tsx` — pure deterministic logic using `cover_id` matching and metadata scoring
- **AI grouper:** `groupEditionsWithClaude()` using Claude Sonnet (claude-sonnet-4-6) — sends edition metadata as JSON and asks for semantic grouping
- **Judge:** `judgeGroupingWithOpus()` using Claude Opus (claude-opus-4-5) — independently scores each grouping 0–100
- Same Opus judge used for both approaches to ensure consistency

## Decision

AI grouping **does not** provide a significant enough improvement over heuristics.

The improvement (0.0 points) is below the 10-point threshold.

The existing `groupEditionsByCover()` heuristic is:
- Fast (no API calls)
- Free (no token cost)
- Deterministic (consistent results)
- Already grouping by `cover_id` which is the most reliable signal available

The AI approach adds latency and cost without sufficient quality gain.
No feature flag will be shipped at this time.