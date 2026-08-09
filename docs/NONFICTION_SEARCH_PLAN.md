# Non-fiction search: duplicate works, missing editions

**Date:** 2026-08-09
**Branch:** `claude/nonfiction-search-grouping-kcexzd`
**Symptom (reported):** search is "weaker" for non-fiction; results aren't grouped
properly on the initial search, so relevant editions are missing from the picker.

## Root cause

Search and edition-fetching are built around the assumption that **one book = one
Open Library work**. That assumption mostly holds for canonical fiction, which OL
librarians have spent years de-duplicating. It does not hold for non-fiction.

`searchBooks()` maps each OL search doc 1:1 to a `BookSearchResult`, and
`getEditions()` fetches `/works/{id}/editions.json` for exactly the one work the
user clicked. So whenever OL splits a book across several work records, the user
sees the same book several times in the dropdown, picks one of them, and gets
only that shard's editions. The rest are invisible — not filtered out, never
fetched.

Four concrete defects follow from this, all of which bite non-fiction harder:

### 1. No de-duplication of works in search results (primary cause)

Non-fiction work records fragment on the subtitle. A single book routinely exists
on OL as `Sapiens`, `Sapiens: A Brief History of Humankind`, and
`Sapiens : a brief history of humankind`, each with its own `/works/OLxxxW` id and
its own slice of the editions. Nothing in `searchBooks()` merges them.

Consequences: duplicate rows in the dropdown; the 10-result budget is spent on
shards of two or three books; and the shard the user happens to click carries a
fraction of the real edition list.

### 2. Editions are fetched from a single work id

`getEditions(workId)` never looks at sibling works. This is the step where the
editions actually go missing — even a user who picks the "right" duplicate only
ever sees that work's ISBNs, so ThriftBooks/AbeBooks pricing runs against a
partial candidate set.

### 3. Non-fiction subtitles are misread as series names

`extractSeriesFromGBTitle()` pattern 1 treats any `X: Y` Google Books title as
series `X`, book `Y`. Fiction titles are rarely colon-separated; non-fiction
titles almost always are (`Bad Blood: Secrets and Lies…`). The result is phantom
series metadata, and — via `detectGBSeriesSearch()` — a whole-result-set re-sort
that can push the actual match down the list. Every genuine series title in the
existing fixtures carries an explicit number marker (`#1`, `Book Two`), so the
number is the signal that separates a series from a subtitle.

### 4. Derivative works consume result slots

Popular non-fiction attracts summaries, study guides, workbooks and "conversation
starters", each a separate OL work with a near-identical title. These are rare for
fiction and common for non-fiction, and they compete for the same 10 slots.

## Fix

1. **Merge duplicate works in `searchBooks()`.** Group results by author +
   normalised title, then attach bare-title records to their subtitled sibling.
   The merged result carries `work_ids: string[]` instead of a single id.
   Deliberately conservative:
   - identical normalised titles merge (tier A);
   - a bare main title merges into a subtitled one only when there is exactly
     **one** candidate (tier B) — so `Sapiens: A Brief History` and
     `Sapiens: A Graphic History` never collapse into each other;
   - authors must match (or one must be unknown);
   - differing volume/part numbers block a merge.
2. **Fetch editions across every merged work.** `getEditions()` accepts a list of
   work ids and de-duplicates by ISBN (the existing `seenIsbns` guard already
   handles overlap).
3. **Resolve siblings for items saved before this change.** Stack items persist
   only `work_id`, so `/api/editions` expands a lone work id into its sibling set
   from `title` + `author`. No schema change, and the fix reaches existing stacks.
4. **Require a number for colon-pattern series extraction**, and widen the
   edition-note rejection list so parenthetical notes (`(Graphic Novel)`,
   `(Large Print)`) stop being read as series names.
5. **Filter derivative works** (summary / study guide / workbook / …) unless the
   query asks for them, and never filter the list down to nothing.

## Deliberately out of scope

- Reordering OL relevance by `edition_count`. Merging plus derivative filtering
  already frees the slots; re-ranking is a separate, riskier change.
- A `work_ids` column on `cart_items`. Server-side sibling resolution covers
  existing rows without a migration.
- Fuzzy title matching. Every merge rule here is exact-match on a normalised
  string; fuzzy matching risks collapsing genuinely different books, which is a
  worse failure than the one being fixed.

## Verification

Unit tests in `src/lib/__tests__/openLibrary.test.ts` cover each merge tier, the
ambiguity guard, the volume guard, derivative filtering, multi-work edition
fetching with ISBN overlap, and the series-number requirement. Live verification
against openlibrary.org was not possible from this session — outbound egress to
`openlibrary.org` and `earmarked.vaidehiagarwalla.com` is blocked by the network
egress proxy — so all tests run against fixtures modelled on real OL payloads.
