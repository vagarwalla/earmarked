---
title: "feat: press issue editor — reorder, add and remove articles before printing"
date: 2026-08-31
status: active
type: feat
depends_on: 2026-08-27-001-feat-press-magazine-pipeline-plan.md
---

# feat: press issue editor

**Built.** Landed as described; the three open questions below were decided
before implementation and their answers are recorded there.

## Summary

`/press` currently lists composed issues, previews the PDF, and links every
article back to its source. The next step is editing: change the running order,
drop an article, pull one forward from the waiting list, and recompose.

## Why it is not just a UI change

The read-only page works because `.press/` is the state: a JSON file and some
directories, read by a server component. Editing changes that in one important
way — a composed issue and its state file can disagree.

Today `scripts/press-run.ts` decides an issue's contents at compose time
(oldest saves first, up to the threshold). Nothing records that decision except
the resulting PDF and `meta.json`. To edit, the *selection* has to become
durable and editable, separate from the composing.

## Design

**1. Make issue membership explicit.**
Add `issues: { number, itemIds: string[], state: 'draft' | 'ordered' }[]` to
`.press/state.json`. `press-run --compose` writes a draft with the selection it
would have made; the editor mutates `itemIds`; composing renders whatever the
draft says. Selection stops being implicit in sort order.

This mirrors what `press_items.issue_id` already does in the deployed schema —
so the local editor and the eventual Supabase version share one model, and
`compose.ts` needs no changes at all.

**2. A small mutation API.** `POST /api/press/issue/[number]` with
`{ action: 'reorder' | 'remove' | 'add', itemIds?, itemId? }`. Server-side,
writes `state.json` under a lock (a `.press/state.lock` file — the runner and
the dev server can both be running).

**3. Recompose on demand, not on every edit.** A 104-page render takes minutes.
Edits mark the draft dirty; a "Rebuild" button runs the compose step and
streams progress. The PDF on disk stays the last built version until then, and
the UI says so.

**4. Drag to reorder** with `@dnd-kit` (already the ecosystem default; adds one
dependency). Remove is a button per row. Add is a picker over the waiting list.

## Scope boundaries

**In scope:** reorder, add, remove, rebuild, and a page-count estimate that
updates live from the per-article counts already in state.

**Out of scope:** editing article *content* (that is a text editor and a
re-render of one fragment), changing the cover design, per-article page-break
control, and anything that needs the deployed Supabase path. Reordering changes
nothing about extraction, so a bad extraction is still fixed by re-saving the
link, not by editing here.

**Explicit non-goal:** making `/press` safe to deploy publicly. It lists a
person's reading. It stays local-only (`pressUiEnabled()`), and the deployed
approval email remains the remote surface.

## Open questions — decided

1. **Should reordering be free, or should the chronological default be
   preserved with manual overrides layered on top?** Free. The draft's
   `itemIds` array *is* the running order. Chronological survives only as the
   seed: `selectForIssue` still picks the oldest saves up to the threshold the
   first time an issue is drafted, and is never consulted for that issue again.
   Layering overrides on a sort key would have been a second model to keep in
   step with `press_items.issue_id`, for no gain the editor could show.

2. **Should an edited issue keep its LLM-generated name, or be re-named?**
   Re-named, on every rebuild. A name that no longer matches the contents is
   worse than a stale one, and `nameIssue()` is one Haiku call. Observed in
   practice: reordering issue 1 renamed it from "Doing Good Seriously" to
   "Doing Good Right", which is the intended behaviour and worth knowing about
   before it surprises someone.

3. **Does a draft need to survive `--printed`?** Yes, sealed rather than
   deleted. `--printed` flips the draft to `state: 'ordered'` instead of
   dropping it, so a past issue's contents stay inspectable and its articles
   stay visibly spoken for (`claimedItemIds`). Every edit to an `ordered`
   issue is refused server-side, and the UI renders it as a plain list with no
   drag handles. Re-printing a past issue is still not a thing you can do from
   here.

## What landed

- `src/lib/press/issues.ts` — the state file's shape, `withStateLock`, and the
  draft model (`ensureDraft`, `applyIssueAction`, `claimedItemIds`).
- `src/lib/press/build.ts` — the compose step, lifted out of `press-run.ts` so
  the runner and the Rebuild button share it, plus `withBuildLock`.
- `POST /api/press/issue/[number]` for reorder/remove/add, and
  `POST /api/press/issue/[number]/rebuild` streaming NDJSON progress.
- `src/app/press/IssueEditor.tsx` — `@dnd-kit` drag-to-reorder over two linked
  lists (the issue and the waiting list), a live page total against the
  threshold, and the Rebuild button.
- `scripts/press-run.ts` now writes the draft at compose time and reports from
  it thereafter; long steps run outside the state lock so the editor is never
  frozen behind a 30-article extraction.

Dirtiness is derived, not stored: the UI compares the draft against
`meta.json`, so a build from any direction reconciles it and there is no flag
to get out of step.
