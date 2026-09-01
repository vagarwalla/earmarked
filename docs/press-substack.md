# press — the Substack harvest

How the reading pool gets filled, and how to fill it again. The pipeline is
`scripts/press-substack.ts`; the selection logic and the reasoning behind every
number is in `src/lib/press/substack.ts`, tested in
`src/lib/press/__tests__/substack.test.ts`.

## The problem it solves

Reading your own subscriptions produces a narrow, repetitive pool. Thirteen
subscriptions yielded eight publications that cleared a quality bar, two of
which took a seventh of the slots between them, and the result was almost
entirely AI and American politics. Variety is not something you can filter your
way to at the end — it has to come from the sources.

So the pipeline has two halves, and the first one matters more:

1. **Widen the source list** until the topics you want are represented.
2. **Rank hard** within it, and cap each source so no one voice dominates.

## Where the data comes from

Substack publishes JSON. No HTML scraping, no browser automation except for the
one endpoint that needs your session cookie.

| What | Endpoint | Notes |
|---|---|---|
| Your subscriptions | `substack.com/api/v1/subscriptions?tvOnly=false&everything=true` | Needs your session, so run it in a logged-in tab. Both params are load-bearing: no `tvOnly` → 400, no `everything` → empty list. Read `publications`; `subscriptions` comes back empty. |
| A publication's archive | `https://<host>/api/v1/archive?sort=new&limit=50&offset=N` | Public. `limit` caps at 50. Use redirects — many publications serve from a custom domain. |
| Who a publication recommends | `https://<host>/api/v1/recommendations/from/<publication_id>` | Public. `publication_id` comes off any archive row. |

Each archive row carries `title`, `subtitle`, `canonical_url`, `post_date`,
`wordcount`, `reaction_count`, `restacks`, `comment_count` and `type`. That is
everything the ranking needs, so no article bodies are ever fetched.

**Rate limits are the main operational hazard.** 429s begin after roughly ten
quick requests. The script sleeps 3s between pages and backs off 15s and up on a
429; a bulk harvest of ~50 publications takes 10–20 minutes and that is fine.

## Widening the source list

Three routes, in rough order of yield:

- **Topic search.** Name the topics that are missing and go looking. This is
  the half a human or a subagent does; the output is just hosts to verify.
- **The recommendation graph.** Walk `recommendations/from/<id>` for every
  publication you already read. These are vouched for by writers you chose, so
  the hit rate is high — though it inherits their biases, and one finance
  newsletter recommending 38 other finance newsletters will swamp the list.
- **Blogrolls.** Someone else's curated list of blogs. Expect a low yield per
  name but a high ceiling; most will be off-topic or dead.

Verify each candidate before adding it to `substack-sources.ts`:

```
curl -sL -A "$UA" "https://<host>/api/v1/archive?sort=new&limit=3&offset=0"
```

If that returns rows with `wordcount` and `reaction_count`, it works. Watch for
publications that verify but do not qualify: short-form dailies, link digests,
and abandoned Substack stubs that redirect elsewhere.

## How a post is scored

```
engagement = reactions + 3 × restacks + ½ × comments
```

A restack is someone spending their own audience's attention on a piece — the
strongest available proxy for "other people carried this further". A comment is
weak and often adversarial, so it counts a half.

Scoring is **absolute, across all publications**. An earlier version scored each
post against its own publication's median, which sounds fairer to small
newsletters and is not: it let a niche newsletter's merely-above-average post
outrank a genuinely iconic essay elsewhere. Variety comes from the caps, not
from the scale.

## The filters, and why each exists

| Filter | Default | Why |
|---|---|---|
| Minimum length | 2,000 words | The pool is for long-form. Below this it is a note. |
| Signpost titles | regex, see `isSignpost` | "You should read X" posts — link roundups, best-of lists, contest *results*, housekeeping — are pointers, not essays. A contest *entry* is an essay and stays. |
| Celebration floor | 120 engagement | Something nobody responded to is not a landmark, however good the topic sounds. |
| Window | 24 months | `landmark` for the last 12, `key` for the 12 before that. |
| Per-source cap | 3 | The variety knob. |

Caps and floors are overridden per source in `substack-sources.ts`, and every
override carries its reason in a comment. A number that appears without one is a
bug.

The cap is applied **after** the global sort, which is what makes it a quality
filter rather than a quota: a source's three slots go to its three best posts as
measured against the whole field.

## Running it

```
npm run press:substack -- --collection <id>            # dry run, prints the diff
npm run press:substack -- --collection <id> --apply    # write
```

It reconciles rather than wiping: items already in the collection that are still
picks are left alone, so anything you have opened, tagged or annotated survives
a re-run. Re-running after editing the source list or a cap is cheap.

**The reconcile only touches its own work.** Every harvested pick is tagged with
its tier (`landmark` / `key`), and only raindrops carrying one of those tags are
eligible for removal. Hand-curated items in the same collection — contest
entries, essays off personal blogs, an author's greatest hits — are counted as
present and never deleted.

## What this pipeline deliberately does not do

Engagement counts are a measure of celebration, not of quality, and they only
exist on Substack. Anything judged on merit rather than on numbers is curated by
hand and tagged separately:

- `acx-contest` — Astral Codex Ten book-review and non-book-review contest
  entries. Ranked by the contest, not by reactions; the entries are essays, the
  winner announcements are signposts.
- `blogroll` — essays off personal blogs with no engagement data at all.
- `classic` — an author's best work, chosen by reputation.
- `all-time` — a specific author's back catalogue.

Judged material needs a person or an agent reading it. The numbers cannot tell
you whether an idea is novel, only whether it was popular.
