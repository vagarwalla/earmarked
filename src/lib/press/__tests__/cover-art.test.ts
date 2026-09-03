import { describe, it, expect } from 'vitest'
import {
  COVER_LAYOUTS,
  COVER_MOTIFS,
  COVER_PALETTES,
  COVER_SCREENS,
  PLATE_MIN_WIDTH,
  coverDesign,
  layoutFor,
  motifFor,
  paletteFamilyFor,
  paletteFor,
  plateFor,
  rgbChannels,
  screenFor,
} from '../cover-art'

/** Every wheel steps with the issue number; none of them may stand still. */
const wheels = {
  palette: (n: number) => paletteFamilyFor(n).key,
  motif: motifFor,
  layout: layoutFor,
  screen: screenFor,
}

describe('cover palettes', () => {
  it('gives consecutive issues different grounds and different colours', () => {
    // A shelf of cream covers reads as one book reprinted. The ground has to
    // change as often as the drawing does.
    for (let n = 1; n <= 40; n++) {
      expect(paletteFamilyFor(n).ground).not.toBe(paletteFamilyFor(n + 1).ground)
      expect(paletteFor(n)[0]).not.toBe(paletteFor(n + 1)[0])
    }
  })

  it('rotates within a family, so two issues of one family do not match either', () => {
    const family = COVER_PALETTES.length
    // Same family, a full cycle apart, but not the same lead colour.
    expect(paletteFamilyFor(1).key).toBe(paletteFamilyFor(1 + family).key)
    expect(paletteFor(1)[0]).not.toBe(paletteFor(1 + family)[0])
    // Deterministic, and it wraps rather than running off the end.
    expect(paletteFor(3)).toEqual(paletteFor(3))
    expect(new Set(paletteFor(3))).toEqual(new Set(paletteFamilyFor(3).colors))
    // A number below the first issue must not index off the front.
    expect(COVER_PALETTES).toContain(paletteFamilyFor(0))
    expect(paletteFor(0)).toHaveLength(COVER_PALETTES[0].colors.length)
  })

  it('keeps each family closed, and its ink clear of its ground', () => {
    for (const p of COVER_PALETTES) {
      expect(p.ground).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(p.ink).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(p.colors.length).toBeGreaterThanOrEqual(5)
      for (const c of p.colors) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/)
      // Type on its own ground has to be readable: the two must be far apart in
      // luminance, whichever way round the family is.
      const lum = (hex: string) => {
        const [r, g, b] = rgbChannels(hex).split(', ').map(Number)
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      }
      expect(Math.abs(lum(p.ink) - lum(p.ground))).toBeGreaterThan(0.5)
    }
  })

  it('reads a hex colour into channels a screen can be laid on in', () => {
    expect(rgbChannels('#14161A')).toBe('20, 22, 26')
    expect(rgbChannels('#fff')).toBe('255, 255, 255')
  })
})

describe('cover design', () => {
  it('turns all four wheels, and never twice the same in a row', () => {
    for (const [name, wheel] of Object.entries(wheels)) {
      for (let n = 1; n <= 40; n++) {
        expect(`${name}@${n}: ${wheel(n)}`).not.toBe(`${name}@${n}: ${wheel(n + 1)}`)
      }
    }
    // And every value of every wheel is reached rather than sitting unused.
    const over = (f: (n: number) => string) => new Set(Array.from({ length: 120 }, (_, i) => f(i + 1)))
    expect(over(motifFor)).toEqual(new Set(COVER_MOTIFS))
    expect(over(layoutFor)).toEqual(new Set(COVER_LAYOUTS))
    expect(over(screenFor)).toEqual(new Set(COVER_SCREENS))
    expect(over((n) => paletteFamilyFor(n).key)).toEqual(new Set(COVER_PALETTES.map((p) => p.key)))
  })

  it('runs 120 issues before a design repeats, and differs even then', () => {
    const shape = (n: number) => {
      const d = coverDesign(n, `Issue ${n}`)
      return [d.palette.key, d.motif, d.layout, d.screen].join('/')
    }
    const first = Array.from({ length: 120 }, (_, i) => shape(i + 1))
    expect(new Set(first).size).toBe(120)
    // Issue 121 comes back round to issue 1's combination — but not to its
    // drawing, because the dials are hashed from the name as well.
    expect(shape(121)).toBe(shape(1))
    expect(coverDesign(121, 'Salt and Ash').layers).not.toBe(coverDesign(1, 'Winter Light').layers)
  })

  it('draws the same issue the same way every time', () => {
    expect(coverDesign(7, 'Winter Light')).toEqual(coverDesign(7, 'Winter Light'))
    // The name alone changes the drawing, so two issues on one motif differ.
    expect(coverDesign(7, 'Winter Light').layers).not.toBe(coverDesign(7, 'Salt and Ash').layers)
  })

  it('draws every issue off its own palette, in valid CSS, referencing nothing', () => {
    for (let n = 1; n <= 60; n++) {
      const d = coverDesign(n, `Issue ${n}`)
      // One size for every layer, or the screens tile at the wrong pitch.
      expect(d.sizes.split(', ').length).toBe(d.stack.length)
      expect(d.layers.startsWith(d.stack[0].image)).toBe(true)
      expect(d.layers).toMatch(/gradient\(/)
      // Balanced parens: an unclosed layer swallows the declaration after it.
      expect(d.layers.split('(').length).toBe(d.layers.split(')').length)
      // Every colour is one of this issue's, the ground showing through, or the
      // ink a screen is struck in. Nothing invents a colour outside the family.
      const used = d.layers.match(/#[0-9A-Fa-f]{3,8}/g) ?? []
      expect(used.every((c) => d.colors.includes(c))).toBe(true)
      expect(d.layers).not.toMatch(/url\(|https?:|@import|NaN|undefined/)
    }
  })

  it('lets a screen be the whole texture when the figure is a photograph', () => {
    const plate = { file: 'lead-abc123.jpg', credit: 'The Paris Review' }
    const d = coverDesign(4, 'Winter Light', { plate })
    expect(d.plate).toEqual(plate)
    // A picture wants the panel or a mat, not a band across the middle.
    expect(['full', 'frame']).toContain(d.layout)
    // Only the screen is drawn: a figure over a photograph fights it.
    expect(d.layers).not.toMatch(/#[0-9A-Fa-f]{6}/)
  })

  it('leaves a cover bare of screen where the wheel says so', () => {
    // `bare` is a real option: not every cover should carry tooth.
    const bare = Array.from({ length: 20 }, (_, i) => i + 1).find((n) => screenFor(n) === 'bare')
    expect(bare).toBeDefined()
    const d = coverDesign(bare as number, 'Winter Light')
    expect(d.layers).not.toMatch(/repeating-linear-gradient\(\d+deg, rgba/)
  })
})

describe('plateFor', () => {
  const big = { path: 'a.jpg', width: 2400, height: 1500 }
  const bigger = { path: 'b.jpg', width: 2800, height: 1700 }
  const small = { path: 'c.jpg', width: 900, height: 600 }
  const portrait = { path: 'd.jpg', width: 2000, height: 2600 }

  it('takes the biggest picture that can carry a 7-inch panel', () => {
    expect(plateFor([small, big, bigger, portrait])).toBe(bigger)
  })

  it('would rather draw the cover than print a soft one', () => {
    // Everything the extractor pulls down is web-sized; this is the common case.
    expect(plateFor([small, portrait])).toBeNull()
    expect(plateFor([])).toBeNull()
    expect(plateFor([{ path: 'e.jpg', width: null, height: null }])).toBeNull()
    // Just under the bar is still under it.
    expect(plateFor([{ path: 'f.jpg', width: PLATE_MIN_WIDTH - 1, height: 900 }])).toBeNull()
    expect(plateFor([{ path: 'g.jpg', width: PLATE_MIN_WIDTH, height: 900 }])).not.toBeNull()
  })

  it('refuses a portrait picture, which crops to nothing across the panel', () => {
    expect(plateFor([{ path: 'h.jpg', width: 2400, height: 2300 }])).toBeNull()
  })
})
