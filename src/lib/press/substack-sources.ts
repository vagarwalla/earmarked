/**
 * press — the publications the Substack harvest reads.
 *
 * Two origins, both recorded in `via`: `subscription` sources came out of the
 * reader's own Substack subscription list, `discovered` ones were found by
 * topic search and by following the recommendation graph out of the
 * subscriptions. The distinction matters when the list is next refreshed — the
 * subscription half should be re-read from the API rather than edited here.
 *
 * `topic` is not decoration. It is the axis variety is measured on, and a
 * harvest that comes back all AI and politics has failed even when every
 * individual pick is good.
 */

import type { Source } from './substack'

export interface ConfiguredSource extends Source {
  via: 'subscription' | 'discovered'
}

export const SOURCES: ConfiguredSource[] = [
  { host: "aisalon.substack.com", publication: "ai salon archive", topic: "AI", via: 'subscription' },
  { host: "dwarkesh.substack.com", publication: "Dwarkesh Podcast", topic: "AI", via: 'subscription' },
  { host: "robotic.substack.com", publication: "Interconnects AI", topic: "AI", via: 'subscription' },
  { host: "jasmi.news", publication: "@jasmine", topic: "anthropology", via: 'discovered' },
  { host: "traditionsofconflict.substack.com", publication: "Traditions of Conflict", topic: "anthropology", via: 'discovered' },
  { host: "www.razibkhan.com", publication: "Razib Khan", topic: "anthropology", via: 'discovered' },
  { host: "www.optimallyirrational.com", publication: "Optimally Irrational", topic: "behavioural science", via: 'discovered' },
  { host: "www.asimov.press", publication: "Asimov Press", topic: "bio", via: 'discovered' },
  { host: "www.owlposting.com", publication: "Owl Posting", topic: "bio", via: 'discovered' },
  { host: "sarahconstantin.substack.com", publication: "Rough Diamonds", topic: "bio", via: 'discovered' },
  { host: "centuryofbio.com", publication: "The Century of Biology", topic: "bio", via: 'discovered' },
  { host: "defensesindepth.substack.com", publication: "Defenses in Depth", topic: "biosecurity", via: 'discovered' },
  { host: "www.bensouthwood.co.uk", publication: "Ben Southwood", topic: "building", via: 'discovered' },
  { host: "www.construction-physics.com", publication: "Construction Physics", topic: "building", via: 'discovered' },
  { host: "botharetrue.substack.com", publication: "Both Are True", topic: "culture", via: 'subscription' },
  { host: "www.global-developments.org", publication: "Global Developments", topic: "development", via: 'discovered' },
  { host: "www.mangosorbananas.com", publication: "Mangos or bananas", topic: "development", via: 'discovered' },
  { host: "manifund.substack.com", publication: "The Fox Says (Manifund)", topic: "EA funding", via: 'subscription' },
  { host: "blog.daviskedrosky.com", publication: "Great Transformations", topic: "economic history", via: 'discovered' },
  { host: "www.broadstreet.blog", publication: "Broadstreet", topic: "economic history", via: 'discovered' },
  { host: "backofmind.substack.com", publication: "Dan Davies \u2014 Back of Mind", topic: "economics", via: 'discovered' },
  { host: "www.noahpinion.blog", publication: "Noahpinion", topic: "economics", via: 'discovered' },
  { host: "www.siliconcontinent.com", publication: "Silicon Continent", topic: "economics", via: 'discovered' },
  { host: "www.thefitzwilliam.com", publication: "The Fitzwilliam", topic: "economics", via: 'discovered' },
  { host: "nabeelqu.substack.com", publication: "Nabeel Qureshi", topic: "essays", via: 'discovered' },
  { host: "behindthebalancesheet.substack.com", publication: "Behind the Balance Sheet", topic: "finance", via: 'subscription' },
  { host: "www.scientificdiscovery.dev", publication: "Scientific Discovery", topic: "global health", via: 'discovered' },
  { host: "www.chinatalk.media", publication: "ChinaTalk", topic: "governance", via: 'discovered' },
  { host: "www.hyperdimensional.co", publication: "Hyperdimensional", topic: "governance", via: 'discovered' },
  { host: "www.statecraft.pub", publication: "Statecraft", topic: "governance", via: 'discovered' },
  { host: "www.ageofinvention.xyz", publication: "Age of Invention", topic: "history", via: 'discovered' },
  { host: "resobscura.substack.com", publication: "Res Obscura", topic: "history", via: 'discovered' },
  { host: "www.freaktakes.com", publication: "FreakTakes", topic: "history of science", via: 'discovered' },
  { host: "criticalmaas.substack.com", publication: "Critical Maas", topic: "history of technology", via: 'discovered' },
  { host: "etiennefd.substack.com", publication: "Hopeful Monsters", topic: "history of technology", via: 'discovered' },
  { host: "www.writingruxandrabio.com", publication: "Ruxandra Teslo", topic: "metascience", via: 'discovered' },
  { host: "nanransohoff.substack.com", publication: "Nan Ransohoff", topic: "philanthropy", via: 'discovered' },
  { host: "benthams.substack.com", publication: "Bentham's Bulldog", topic: "philosophy", via: 'subscription' },
  { host: "natesilver.substack.com", publication: "Silver Bulletin", topic: "politics", via: 'subscription' },
  { host: "theargument.substack.com", publication: "The Argument", topic: "politics", via: 'subscription' },
  { host: "newsletter.rootsofprogress.org", publication: "Roots of Progress", topic: "progress", via: 'discovered' },
  { host: "www.worksinprogress.news", publication: "Works in Progress", topic: "progress", via: 'discovered' },
  { host: "www.afterbabel.com", publication: "After Babel", topic: "psychology", via: 'discovered' },
  { host: "cognitivewonderland.substack.com", publication: "Cognitive Wonderland", topic: "psychology", via: 'discovered' },
  { host: "www.conspicuouscognition.com", publication: "Conspicuous Cognition", topic: "psychology", via: 'discovered' },
  { host: "www.experimental-history.com", publication: "Experimental History", topic: "psychology", via: 'discovered' },
  { host: "www.robkhenderson.com", publication: "Rob Henderson", topic: "psychology", via: 'discovered' },
  { host: "sashachapin.substack.com", publication: "Sasha Chapin", topic: "psychology", via: 'discovered' },
  { host: "www.secretorum.life", publication: "Secretum Secretorum", topic: "psychology", via: 'discovered' },
  { host: "www.stevestewartwilliams.com", publication: "Steve Stewart-Williams", topic: "psychology", via: 'discovered' },
  { host: "www.theintrinsicperspective.com", publication: "The Intrinsic Perspective", topic: "psychology", via: 'discovered' },
  { host: "www.ian-leslie.com", publication: "The Ruffian", topic: "psychology", via: 'discovered' },
  { host: "usefulfictions.substack.com", publication: "Useful Fictions", topic: "psychology", via: 'subscription' },
  { host: "www.aporiamagazine.com", publication: "Aporia", topic: "social science", via: 'discovered' },
  { host: "www.cremieux.xyz", publication: "Cremieux Recueil", topic: "social science", via: 'discovered' },
  { host: "www.everythingisbullshit.blog", publication: "Everything Is Bullshit", topic: "social science", via: 'discovered' },
  { host: "www.cartoonshateher.com", publication: "Cartoons Hate Her", topic: "sociology", via: 'discovered' },
  { host: "www.ggd.world", publication: "The Great Gender Divergence", topic: "sociology", via: 'discovered' },
  { host: "contraptions.substack.com", publication: "Contraptions", topic: "tech culture", via: 'subscription' },
]

/**
 * Deviations from the default cap of three, with the reason attached. A number
 * here is a judgement about a publication, so it should never appear without
 * one.
 */
export const CAP_BY_SOURCE: Record<string, number> = {
  // Every entry is by a different writer, so the showcase *is* the variety.
  'www.astralcodexten.com': 14,
  // "Only the very top, and only if it's more iconic than others."
  'benthams.substack.com': 2,
  // News-adjacent: the long-form bar already strips the daily takes, and two
  // slots keeps what is left from crowding out quieter topics.
  'natesilver.substack.com': 2,
  'theargument.substack.com': 2,
  // These three came into the config already represented by hand-picked items
  // the reconcile will not touch, so the default three would stack on top of
  // what is already there. The cap is a judgement about total presence in the
  // collection, not about a single harvest — each number is the default less
  // the hand-picked count, floored at one so the source still stays current.
  'www.global-developments.org': 1,   // 6 hand-picked
  'www.broadstreet.blog': 2,          // 3 hand-picked
  // 2 hand-picked, and Buckner also publishes at traditionsofconflict.com,
  // which is a separate host and so invisible to this cap. Dedupe him by
  // author, not by domain.
  'traditionsofconflict.substack.com': 2,
}

/** Sources held to a higher bar than the global floor, with the reason. */
export const FLOOR_BY_SOURCE: Record<string, number> = {
  // A very prolific publication clears a 120 floor several times a month; at
  // 500 only the genuinely iconic posts survive, which is what was asked for.
  'benthams.substack.com': 500,
}

/**
 * Dropped wholesale. Length alone does not make an essay: these publish long
 * digests whose titles are just comma-lists of the items inside, which the
 * signpost regex cannot see.
 */
export const EXCLUDE_SOURCES = new Set<string>([
  'www.stevestewartwilliams.com',
  'behindthebalancesheet.substack.com',
])
