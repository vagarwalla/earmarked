/**
 * press — what is a reference page rather than reading.
 *
 * An organisation's About page, a docs index or a product landing page
 * extracts into several plausible pages of prose, and then gets a full
 * magazine opener headlined "About" — which reads as a mistake in a printed
 * contents list, and costs the pages it takes.
 *
 * The tell is a bare generic noun where a title should be. That is a weak
 * signal deliberately: it fires only on titles that are one word of furniture
 * and nothing else, so an essay called "On Careers" or "The Home Front" is
 * untouched. The cost of a false negative is one bad opener the reader can
 * drop by hand; the cost of a false positive is an essay silently missing
 * from an issue, which is much worse.
 *
 * A match marks the item `skipped`, never dropped, and it is always reported:
 * the call is the reader's, and un-skipping is one click in the workbench or a
 * one-word edit in `.press/state.json`.
 *
 * Lives here rather than in `scripts/press-run.ts`, where it started, because
 * the rule is about what may reach a printed issue and not about which runtime
 * noticed — and because a rule with no test is a rule that quietly stops
 * working. See `__tests__/reference-page.test.ts`.
 */

/**
 * Titles that are page furniture rather than the name of a piece of writing.
 *
 * Anchored at both ends on purpose: the whole title has to be the generic
 * noun. "About" is a reference page; "About a Boy" is not.
 */
const GENERIC_TITLES = [
  /^about(\s+us)?$/i, /^home$/i, /^index$/i, /^untitled$/i, /^overview$/i,
  /^team$/i, /^our team$/i, /^contact(\s+us)?$/i, /^careers?$/i, /^jobs$/i,
  /^faq$/i, /^docs?$/i, /^documentation$/i, /^mission$/i, /^welcome$/i,
  /^getting started$/i, /^resources$/i,
]

/** The reason recorded on an item this rule excludes. */
export const REFERENCE_PAGE_REASON = 'reference page, not an article'

/** True when this title says the page is furniture rather than reading. */
export function isReferencePage(title: string | null | undefined): boolean {
  if (!title) return false
  return GENERIC_TITLES.some((re) => re.test(title.trim()))
}
