import { describe, it, expect } from 'vitest'
import { cleanTitle } from '../title'

describe('cleanTitle', () => {
  it('strips markup an extractor left in the title', () => {
    // Issue 4's back cover printed these characters.
    expect(cleanTitle('<em>g</em>, a Statistical Myth', 'bactra.org', 'http://bactra.org/weblog/523.html'))
      .toBe('g, a Statistical Myth')
    expect(cleanTitle('In Soviet Union, Optimization Problem Solves <em>You</em>', null, null))
      .toBe('In Soviet Union, Optimization Problem Solves You')
    expect(cleanTitle('Salt &amp; Sugar &#39;97', null, null)).toBe("Salt & Sugar '97")
  })

  it('cuts the publication name off either end', () => {
    const wip = 'https://worksinprogress.co/issue/x/'
    // Issue 8's cover said "Works in Progress Magazine" three times.
    expect(cleanTitle('Why we didn\'t get a malaria vaccine sooner - Works in Progress Magazine', 'worksinprogress.co', wip))
      .toBe("Why we didn't get a malaria vaccine sooner")
    // Even when sourceName is the author rather than the publication.
    expect(cleanTitle('How Mexico built a state - Works in Progress Magazine', 'Robin Grier', wip))
      .toBe('How Mexico built a state')
    // And when the site puts its name first.
    expect(cleanTitle('Nintil - The Soviet Union: Productive Efficiency', 'Jose Luis Ricon', 'https://nintil.com/x'))
      .toBe('The Soviet Union: Productive Efficiency')
  })

  it('leaves a title that merely contains a dash alone', () => {
    // The segment has to actually name the site, or the cut is a mistake.
    expect(cleanTitle('The Idea That Eats Smart People - and Why', 'idlewords.com', 'https://idlewords.com/talks/x.htm'))
      .toBe('The Idea That Eats Smart People - and Why')
    expect(cleanTitle('Cooking Up Mehran’s Steak House', 'Substack', 'https://x.substack.com/p/y'))
      .toBe('Cooking Up Mehran’s Steak House')
  })

  it('never cuts a title down to nothing', () => {
    // A piece genuinely called after its publication keeps its name.
    expect(cleanTitle('Nintil', 'Jose Luis Ricon', 'https://nintil.com/x')).toBe('Nintil')
    expect(cleanTitle('Works in Progress - Works in Progress', null, 'https://worksinprogress.co/x'))
      .toBe('Works in Progress')
    expect(cleanTitle('', null, null)).toBe('')
    expect(cleanTitle(null, null, null)).toBe('')
  })

  it('does nothing dangerous without a site to check against', () => {
    // Only the markup half runs; no separator is touched.
    expect(cleanTitle('A Title - With A Dash', null, null)).toBe('A Title - With A Dash')
  })
})
