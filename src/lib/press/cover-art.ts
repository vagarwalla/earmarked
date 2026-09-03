/**
 * press — cover art.
 *
 * One issue, one cover, and no two of them alike. What varies is not just the
 * drawing: the ground the spread prints on, the palette, where the art sits on
 * the panel, how the title sets against it, and the screen laid over the whole
 * thing. Four wheels, all turning at different rates —
 *
 *   palette   8 families, stepping with the issue number
 *   motif    12 figures,  stepping with the issue number
 *   layout    5 ways of placing art and type
 *   screen    5 textures, from a fine grain to a coarse halftone
 *
 * — so consecutive issues share none of the four, and an exact repeat of the
 * combination is 120 issues away. Inside a motif the numbers that shape it come
 * off a hash of the issue's number *and* its name, so even a repeat is drawn
 * differently. All of it is deterministic: re-composing an issue prints the
 * cover it printed before.
 *
 * What keeps them a series rather than a jumble is the grammar they share:
 * flat colour with hard stops and nothing interpolating, one screen over the
 * art, the ground of the paper as the drawing's negative space, art that bleeds
 * off the trim, and the same typographic frame — eyebrow, hairline, title.
 *
 * The figures are CSS: gradients, not rasters. Lulu wants 300 PPI on the cover
 * and CSS has no resolution to be wrong at — Chromium rasterises it at whatever
 * the PDF is written at. A *photograph* is the one thing that cannot be drawn,
 * so a cover takes one only when the file is big enough to hold up at 7 inches
 * (see `plateFor`), and prints it screened rather than bare.
 */

// ── Palette ──────────────────────────────────────────────────────────────────

export interface CoverPalette {
  key: string
  /** The ground the whole spread prints on. */
  ground: string
  /** Type on that ground. */
  ink: string
  /** The colours the figure is struck in, in the order they are used. */
  colors: string[]
}

/**
 * Eight grounds, not one. A shelf of cream covers reads as a series of one
 * book; the ground changing from cream to charcoal to navy is what makes the
 * next issue feel like a different object rather than a recolour of the last.
 * Each family is closed: its colours are chosen to sit on its own ground, so
 * they are never mixed between families.
 */
export const COVER_PALETTES: CoverPalette[] = [
  {
    // Riso brights on cream — the register the press started in.
    key: 'riso',
    ground: '#F4F1EA',
    ink: '#14161A',
    colors: ['#E9A93A', '#D9603B', '#B8324B', '#6E3A6B', '#2B4C9B', '#1E7F6B'],
  },
  {
    // Night navy, warm metals: the cover reads dark across a room.
    key: 'dusk',
    ground: '#151C2E',
    ink: '#EFE7D8',
    colors: ['#E4B363', '#D97A6C', '#6FA8A0', '#9186C9', '#EFE7D8', '#3E5C8A'],
  },
  {
    // Herbarium: field greens and clay on bone.
    key: 'botanic',
    ground: '#EDE8DA',
    ink: '#23291F',
    colors: ['#4F6B3A', '#C0793C', '#2F4A3C', '#D9B03C', '#7A4B2A', '#8C9A6A'],
  },
  {
    // Ink and bone. Nearly monochrome, with two colours allowed in.
    key: 'press',
    ground: '#1B1B1E',
    ink: '#F0EBE1',
    colors: ['#F0EBE1', '#D8A13A', '#A32E37', '#6F7F8C', '#8FA37E', '#C9643B'],
  },
  {
    // Cold light on water.
    key: 'tide',
    ground: '#E6EDF0',
    ink: '#16232B',
    colors: ['#1F3A6E', '#2E7FA8', '#7FC3B4', '#E0B979', '#D96F5E', '#123B4A'],
  },
  {
    // Low sun: everything warm, on a ground the colour of a dark room.
    key: 'ember',
    ground: '#241611',
    ink: '#F3E5D2',
    colors: ['#E2703A', '#E8B33C', '#F3E5D2', '#B0432A', '#7A4A6B', '#3F6F63'],
  },
  {
    // Stone, oxide and jade on greige.
    key: 'mineral',
    ground: '#DBD7CE',
    ink: '#1E2224',
    colors: ['#4A5B62', '#B4693B', '#2E6B5E', '#5B4762', '#22303A', '#8C9A8E'],
  },
  {
    // Blush ground, a printed-textile palette.
    key: 'bloom',
    ground: '#F2E7E3',
    ink: '#2A1E22',
    colors: ['#C4485F', '#E0714B', '#7A4A78', '#3B4E7A', '#E8B54B', '#7F9469'],
  },
]

/** Kept for the covers already printed: the family the press started in. */
export const COVER_PALETTE = COVER_PALETTES[0].colors

/** The family an issue prints in. Consecutive issues never share one. */
export function paletteFamilyFor(issueNumber: number): CoverPalette {
  const n = COVER_PALETTES.length
  return COVER_PALETTES[((Math.trunc(issueNumber) - 1) % n + n) % n]
}

/**
 * This issue's colours: its family's, rotated by the issue number, so two
 * issues of the same family do not lead with the same colour either.
 */
export function paletteFor(issueNumber: number, length?: number): string[] {
  const family = paletteFamilyFor(issueNumber)
  const n = family.colors.length
  const offset = ((Math.trunc(issueNumber) - 1) % n + n) % n
  return Array.from({ length: length ?? n }, (_, i) => family.colors[(offset + i) % n])
}

/** Rough perceived lightness, 0-1. Enough to tell a ground from its ink. */
function luminance(hex: string): number {
  const [r, g, b] = rgbChannels(hex).split(', ').map(Number)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** The colour a full-bleed cover stands on: type is reversed out of it. */
function darkest(colors: string[]): string {
  return colors.reduce((a, b) => (luminance(b) < luminance(a) ? b : a))
}

/** `#rrggbb` → `r, g, b`, for building the rgba() a screen is laid on in. */
export function rgbChannels(hex: string): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(full.slice(0, 6), 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

// ── Seeds and dials ──────────────────────────────────────────────────────────

/** FNV-1a, 32-bit: small, dependency-free, and stable from run to run. */
function hash32(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * The dials a figure is drawn with — an angle, a radius, a band count. Each is
 * read off the issue's seed under its own name, so adding a dial to a motif
 * does not shift the ones already there.
 */
export interface Dials {
  /** A whole number in [lo, hi]. */
  int(salt: string, lo: number, hi: number): number
  /** A number in [lo, hi). */
  span(salt: string, lo: number, hi: number): number
}

function dialsFor(seed: number): Dials {
  const at = (salt: string) => hash32(salt, seed)
  return {
    int: (salt, lo, hi) => lo + (at(salt) % (hi - lo + 1)),
    span: (salt, lo, hi) => lo + ((at(salt) % 1024) / 1024) * (hi - lo),
  }
}

const pc = (n: number) => `${n.toFixed(1)}%`

// ── Drawing primitives ───────────────────────────────────────────────────────

/**
 * One background layer: an image, the tile it is drawn on, where that tile
 * sits, and whether it repeats. Four lists come out of a design rather than
 * one, because a layer that fills the box and a screen that tiles across it
 * need different answers to all four.
 */
export interface Layer {
  image: string
  /** A CSS `background-size`. `100% 100%` for a layer that fills the box. */
  size: string
  /** A CSS `background-position`. */
  pos: string
  /** A CSS `background-repeat`. */
  repeat: 'repeat' | 'no-repeat'
}

/** A layer covering the whole box. */
const fill = (image: string): Layer => ({
  image,
  size: '100% 100%',
  pos: '0 0',
  repeat: 'no-repeat',
})

/** A layer covering one rectangle of the box and nothing else. */
const block = (color: string, size: string, pos: string): Layer => ({
  image: `linear-gradient(${color} 0 100%)`,
  size,
  pos,
  repeat: 'no-repeat',
})

/** A layer tiled across the box on its own pitch — how a screen is laid. */
const tile = (image: string, size: string): Layer => ({ image, size, pos: '0 0', repeat: 'repeat' })

/**
 * A run of bands across a stretch of the gradient line. Every stop is hard —
 * each colour ends exactly where the next begins — because a flat plate does
 * not gradate, and because a colour left to interpolate towards `transparent`
 * fringes grey on the way there.
 */
function bandStops(colors: string[], from: number, to: number, unit = '%'): string {
  const step = (to - from) / colors.length
  return colors
    .map((c, i) => {
      const a = (from + i * step).toFixed(1)
      const b = (from + (i + 1) * step).toFixed(1)
      return `${c} ${a}${unit} ${b}${unit}`
    })
    .join(', ')
}

/** Concentric rings with the ground left showing between them. */
function ringStops(colors: string[], inner: number, outer: number, gap: number): string {
  const step = (outer - inner) / colors.length
  const parts = [`transparent 0 ${pc(inner)}`]
  colors.forEach((c, i) => {
    const a = inner + i * step
    const b = a + step - gap
    parts.push(`${c} ${pc(a)} ${pc(b)}`, `transparent ${pc(b)} ${pc(a + step)}`)
  })
  return parts.join(', ')
}

/** Weights that sum to 1 — uneven, but never so uneven a band disappears. */
function weights(d: Dials, salt: string, n: number): number[] {
  const raw = Array.from({ length: n }, (_, i) => 0.6 + d.span(`${salt}-w${i}`, 0, 0.8))
  const total = raw.reduce((a, b) => a + b, 0)
  return raw.map((w) => w / total)
}

/**
 * Bands of unequal width laid end to end, with one seam of ground left open
 * between two of them. A seam rather than a dropped band: a band turned to
 * ground leaves a hole in the middle of the figure, where a seam reads as one
 * plate lifted off the next.
 */
function unevenStops(colors: string[], ws: number[], seam: { at: number; width: number }): string {
  let at = 0
  const parts: string[] = []
  colors.forEach((c, i) => {
    const from = at * 100
    at += ws[i]
    const to = at * 100
    const cut = i === seam.at ? seam.width : 0
    parts.push(`${c} ${pc(from)} ${pc(to - cut)}`)
    if (cut) parts.push(`transparent ${pc(to - cut)} ${pc(to)}`)
  })
  return parts.join(', ')
}

/**
 * One flat disc. Sized `closest-side`, so the radius is measured against the
 * short edge of the box and a taller panel does not inflate it.
 */
function disc(color: string, x: number, y: number, r: number): string {
  return `radial-gradient(circle closest-side at ${pc(x)} ${pc(y)}, ${color} 0 ${pc(r)}, transparent ${pc(r)})`
}

/** Bands held to the foot of the box — the ground a figure stands on. */
function footing(colors: string[], from: number, ws: number[]): string {
  let at = from
  const parts = [`transparent 0 ${pc(from)}`]
  colors.forEach((c, i) => {
    const next = at + ws[i] * (100 - from)
    parts.push(`${c} ${pc(at)} ${pc(next)}`)
    at = next
  })
  return `linear-gradient(to bottom, ${parts.join(', ')})`
}

// ── Motifs ───────────────────────────────────────────────────────────────────

export const COVER_MOTIFS = [
  'orbit',
  'arches',
  'rays',
  'strata',
  'columns',
  'eclipse',
  'horizon',
  'ripple',
  'dunes',
  'scales',
  'peaks',
  'quarters',
] as const

export type CoverMotif = (typeof COVER_MOTIFS)[number]

/** The figure this issue is drawn with. Consecutive issues never share one. */
export function motifFor(issueNumber: number): CoverMotif {
  const n = COVER_MOTIFS.length
  return COVER_MOTIFS[((Math.trunc(issueNumber) - 1) % n + n) % n]
}

/**
 * Each motif returns its background layers, front first. They all bleed off
 * whichever edges the layout gives them, and none of them reference anything.
 */
const MOTIF_LAYERS: Record<CoverMotif, (colors: string[], d: Dials) => Layer[]> = {
  /** Concentric hard bands struck from the outer bottom corner. */
  orbit: (colors, d) => {
    const rings = colors.slice(0, d.int('orbit-rings', 4, colors.length))
    // Past 100% is past the box's far corner: the outermost band has to reach
    // beyond it, or the corner prints as bare ground.
    const reach = d.span('orbit-reach', 106, 124)
    return [
      fill(
        `radial-gradient(circle at 100% 100%, ${bandStops(rings, 0, reach)}, transparent ${pc(reach)})`,
      ),
    ]
  },

  /** Half-rings rising from the foot, with the ground between them. */
  arches: (colors, d) => [
    fill(
      `radial-gradient(circle at ${pc(d.span('arch-x', 34, 66))} 100%, ${ringStops(
        colors.slice(0, d.int('arch-count', 3, 5)),
        d.span('arch-inner', 16, 32),
        d.span('arch-outer', 98, 122),
        d.span('arch-gap', 3, 6),
      )})`,
    ),
  ],

  /** A fan of wedges opening from the outer bottom corner. */
  rays: (colors, d) => {
    const wedges = colors.slice(0, d.int('ray-count', 4, colors.length))
    // 270deg puts the fan's zero on the left of the corner, so the box is one
    // quadrant of it, and the tilt swings the fan off square. The wedges are
    // spread over 108deg rather than 90 so that whatever the tilt the fan still
    // overruns the quadrant: a wedge stopping short of the edge leaves a
    // hairline of ground down the trim, and it prints as a sawtooth.
    const tilt = d.span('ray-tilt', 0, 18)
    return [
      fill(
        `conic-gradient(from ${(270 - tilt).toFixed(1)}deg at 100% 100%, ${bandStops(wedges, 0, 108, 'deg')})`,
      ),
    ]
  },

  /** Horizontal seams of unequal depth, one of them opened to the ground. */
  strata: (colors, d) => {
    const n = d.int('strata-count', 4, colors.length)
    const seam = { at: d.int('strata-seam', 0, n - 2), width: d.span('strata-seam-w', 2.4, 4.6) }
    return [
      fill(`linear-gradient(to bottom, ${unevenStops(colors.slice(0, n), weights(d, 'strata', n), seam)})`),
    ]
  },

  /** Vertical columns of unequal width, crossed by a single rule. */
  columns: (colors, d) => {
    const n = d.int('col-count', 4, colors.length)
    const seam = { at: d.int('col-seam', 0, n - 2), width: d.span('col-seam-w', 2, 4) }
    const rule = d.span('col-rule', 52, 74)
    return [
      // Listed first, so the rule lies over the columns rather than under them,
      // and struck in the ground so it reads against every column it crosses.
      fill(
        `linear-gradient(to bottom, transparent 0 ${pc(rule)}, var(--ground) ${pc(rule)} ${pc(
          rule + 1.6,
        )}, transparent ${pc(rule + 1.6)})`,
      ),
      fill(`linear-gradient(to right, ${unevenStops(colors.slice(0, n), weights(d, 'col', n), seam)})`),
    ]
  },

  /**
   * Two discs, the nearer punched out of the further in the ground colour,
   * standing in banded footing. The offset is held to a fraction of the radius
   * so the crescent is always cut from a disc it overlaps.
   */
  eclipse: (colors, d) => {
    const r = d.span('ecl-r', 58, 76)
    const x = d.span('ecl-x', 30, 46)
    const y = d.span('ecl-y', 38, 50)
    return [
      fill(disc('var(--ground)', x + d.span('ecl-dx', 9, 16), y - d.span('ecl-dy', 5, 11), r * 0.84)),
      fill(disc(colors[0], x, y, r)),
      fill(footing(colors.slice(1, 3), d.span('ecl-ground', 62, 72), weights(d, 'ecl', 2))),
    ]
  },

  /** A disc rising out of banded ground. */
  horizon: (colors, d) => {
    const line = d.span('hor-line', 46, 62)
    const n = d.int('hor-bands', 2, 4)
    return [
      // The footing is the front layer, so the disc is cut by the horizon.
      fill(footing(colors.slice(1, 1 + n), line, weights(d, 'hor', n))),
      fill(disc(colors[0], d.span('hor-x', 34, 66), line, d.span('hor-r', 46, 70))),
    ]
  },

  /**
   * Thin rings all the way out from one point — a struck-stone ripple. The
   * ring spacing is even and fine, so this is the one figure that reads as
   * pattern rather than as shape.
   */
  ripple: (colors, d) => {
    const ring = d.span('rip-ring', 2.6, 4.4)
    const pair = colors.slice(0, 2)
    return [
      fill(
        `repeating-radial-gradient(circle at ${pc(d.span('rip-x', 24, 76))} ${pc(
          d.span('rip-y', 26, 74),
        )}, ${pair[0]} 0 ${pc(ring)}, ${pair[1]} ${pc(ring)} ${pc(ring * 2)})`,
      ),
    ]
  },

  /**
   * Overlapping hills standing on the foot of the box, each cut off by the one
   * in front of it. Ellipses with their axes given outright rather than discs:
   * a disc's radius is measured off whichever edge is nearer, so the same
   * figure would be a hill in a wide box and a bubble in a tall one.
   */
  dunes: (colors, d) => {
    const n = d.int('dune-count', 3, 4)
    return Array.from({ length: n }, (_, i) => {
      // Front to back: each hill is wider, lower and further along the range.
      const w = d.span(`dune-w${i}`, 42, 62) + i * 10
      const h = d.span(`dune-h${i}`, 38, 56) - i * 6
      const x = d.span(`dune-x${i}`, 4 + i * 26, 30 + i * 26)
      return fill(
        `radial-gradient(ellipse ${pc(w)} ${pc(h)} at ${pc(x)} 100%, ${
          colors[i % colors.length]
        } 0 100%, transparent 100%)`,
      )
    })
  },

  /** A field of scallops — printed textile, or roof tiles. */
  scales: (colors, d) => {
    const cell = d.span('scale-cell', 46, 72)
    const pair = colors.slice(0, 2)
    return [
      tile(
        `radial-gradient(circle at 50% 0, ${pair[0]} 0 52%, ${pair[1]} 52% 100%)`,
        `${cell.toFixed(1)}pt ${(cell * 0.62).toFixed(1)}pt`,
      ),
    ]
  },

  /** A range of peaks standing on a floor, each cut by the one in front. */
  peaks: (colors, d) => {
    const n = d.int('peak-count', 3, 5)
    const floor = d.span('peak-floor', 72, 84)
    return [
      ...Array.from({ length: n }, (_, i) => {
        // Half-width, height and position given outright: a triangle drawn as
        // a conic wedge changes shape with the box, an ellipse-free cone does
        // not. Each peak rises from the floor line to its own summit.
        const w = d.span(`peak-w${i}`, 14, 26)
        const cx = 8 + (i * 84) / n + d.span(`peak-x${i}`, 0, 10)
        const top = d.span(`peak-top${i}`, 18, 46)
        return fill(
          `conic-gradient(from ${(180 - w).toFixed(1)}deg at ${pc(cx)} ${pc(top)}, ${
            colors[i % colors.length]
          } 0 ${(w * 2).toFixed(1)}deg, transparent ${(w * 2).toFixed(1)}deg)`,
        )
      }),
      fill(footing(colors.slice(-2), floor, weights(d, 'peak', 2))),
    ]
  },

  /** The box quartered on an off-centre cross, each quarter its own colour. */
  quarters: (colors, d) => {
    const x = d.span('qtr-x', 34, 62)
    const y = d.span('qtr-y', 38, 64)
    const seam = d.span('qtr-seam', 1.2, 2.6)
    // Each quarter is placed rather than layered: four full-width bands over
    // each other would leave only the front one showing.
    const quads: Layer[] = [
      block(colors[0], `${pc(x)} ${pc(y)}`, '0 0'),
      block(colors[1], `${pc(100 - x)} ${pc(y)}`, '100% 0'),
      block(colors[2], `${pc(x)} ${pc(100 - y)}`, '0 100%'),
      block(colors[3] ?? colors[0], `${pc(100 - x)} ${pc(100 - y)}`, '100% 100%'),
    ]
    return [
      // The cross itself, struck in the ground: two hairlines the quarters
      // stand apart on.
      fill(
        `linear-gradient(to right, transparent 0 ${pc(x - seam / 2)}, var(--ground) ${pc(
          x - seam / 2,
        )} ${pc(x + seam / 2)}, transparent ${pc(x + seam / 2)})`,
      ),
      fill(
        `linear-gradient(to bottom, transparent 0 ${pc(y - seam / 2)}, var(--ground) ${pc(
          y - seam / 2,
        )} ${pc(y + seam / 2)}, transparent ${pc(y + seam / 2)})`,
      ),
      ...quads,
    ]
  },
}

// ── Screens ──────────────────────────────────────────────────────────────────

/**
 * The texture laid over the figure. Drawn as a screen of dots or lines the way
 * a riso or a letterpress plate leaves tooth — and drawn in CSS for the same
 * reason the figures are: it has to survive at 300 PPI, where a bitmap grain
 * would print as mush.
 *
 * Always struck in near-black, never in the palette's ink. Half the families
 * print on a dark ground, where their ink is bone — and a bone screen does not
 * read as tooth, it reads as haze over the whole figure. Ink darkens.
 */
const SCREEN_INK = '12, 12, 14'

export const COVER_SCREENS = ['grain', 'halftone', 'hatch', 'weave', 'bare'] as const
export type CoverScreen = (typeof COVER_SCREENS)[number]

export function screenFor(issueNumber: number): CoverScreen {
  const n = COVER_SCREENS.length
  return COVER_SCREENS[((Math.trunc(issueNumber) - 1) % n + n) % n]
}

const SCREEN_LAYERS: Record<CoverScreen, (ink: string, d: Dials) => Layer[]> = {
  /** Tooth: two fine dot screens at different pitches, barely there. */
  grain: (ink, d) => {
    const a = d.span('grain-a', 1.1, 1.6)
    return [
      tile(
        `radial-gradient(circle at 30% 30%, rgba(${ink}, 0.13) 0 38%, transparent 38%)`,
        `${a.toFixed(2)}pt ${a.toFixed(2)}pt`,
      ),
      tile(
        `radial-gradient(circle at 70% 65%, rgba(${ink}, 0.09) 0 32%, transparent 32%)`,
        `${(a * 1.7).toFixed(2)}pt ${(a * 1.9).toFixed(2)}pt`,
      ),
    ]
  },

  /** A coarse dot screen — a photograph's halftone, over a drawing. */
  halftone: (ink, d) => {
    const cell = d.span('half-cell', 3.4, 5.2)
    return [
      tile(
        `radial-gradient(circle at 50% 50%, rgba(${ink}, 0.17) 0 30%, transparent 30%)`,
        `${cell.toFixed(2)}pt ${cell.toFixed(2)}pt`,
      ),
    ]
  },

  /** Engraver's hatching, at an angle off the horizontal. */
  hatch: (ink, d) => [
    fill(
      `repeating-linear-gradient(${d.span('hatch-a', 18, 74).toFixed(1)}deg, rgba(${ink}, 0.14) 0 0.5pt, transparent 0.5pt ${d
        .span('hatch-p', 3, 5)
        .toFixed(2)}pt)`,
    ),
  ],

  /** Two hatchings crossed — canvas, or a coarse screen mesh. */
  weave: (ink, d) => {
    const p = d.span('weave-p', 3.4, 5.4)
    return [
      fill(`repeating-linear-gradient(90deg, rgba(${ink}, 0.10) 0 0.5pt, transparent 0.5pt ${p.toFixed(2)}pt)`),
      fill(`repeating-linear-gradient(0deg, rgba(${ink}, 0.10) 0 0.5pt, transparent 0.5pt ${p.toFixed(2)}pt)`),
    ]
  },

  /** Nothing at all: flat colour, printed clean. */
  bare: () => [],
}

// ── Layout ───────────────────────────────────────────────────────────────────

/**
 * Where the art sits on the panel and how the title sets against it. This is
 * the wheel that does most of the work: a full-bleed cover with the title
 * reversed out of the art is a different object from a plate matted in the
 * middle of the paper, however the figure inside it is drawn.
 */
export const COVER_LAYOUTS = ['plate', 'full', 'banner', 'frame', 'foot'] as const
export type CoverLayout = (typeof COVER_LAYOUTS)[number]

export function layoutFor(issueNumber: number): CoverLayout {
  const n = COVER_LAYOUTS.length
  return COVER_LAYOUTS[((Math.trunc(issueNumber) - 1) % n + n) % n]
}

// ── A cover ──────────────────────────────────────────────────────────────────

/** A photograph good enough to print at 7 inches. See `plateFor`. */
export interface CoverPlate {
  /** The file name the renderer will have written into `images/`. */
  file: string
  /** Whose picture it is, printed small on the back. */
  credit: string | null
}

export interface CoverDesign {
  palette: CoverPalette
  /** The palette's colours, rotated for this issue. */
  colors: string[]
  motif: CoverMotif
  layout: CoverLayout
  screen: CoverScreen
  /** The rule and spine numeral colour. */
  accent: string
  /** The art box's layers, front first — the CSS lists below, unjoined. */
  stack: Layer[]
  /** `background-image` for the art box, front layer first. */
  layers: string
  /** The matching `background-size` list. */
  sizes: string
  /** The matching `background-position` list. */
  positions: string
  /** The matching `background-repeat` list. */
  repeats: string
  /** Set when the cover carries a photograph rather than a drawing. */
  plate: CoverPlate | null
}

export interface CoverDesignOptions {
  /** A photograph to print instead of a figure, when there is one. */
  plate?: CoverPlate | null
}

/**
 * The whole design for one issue. Pure, and deterministic in the issue's
 * number and name.
 */
export function coverDesign(
  issueNumber: number,
  issueName: string,
  opts: CoverDesignOptions = {},
): CoverDesign {
  const palette = paletteFamilyFor(issueNumber)
  const colors = paletteFor(issueNumber)
  const motif = motifFor(issueNumber)
  const screen = screenFor(issueNumber)
  const plate = opts.plate ?? null
  const d = dialsFor(hash32(`${Math.trunc(issueNumber)} ${issueName}`))

  // A photograph wants the whole panel or a mat around it; the other three
  // layouts are built to hold a drawing and crop a picture badly.
  const layout = plate
    ? ((['full', 'frame'] as const)[d.int('plate-layout', 0, 1)])
    : layoutFor(issueNumber)

  // Over a photograph the figure would fight the picture, so the art box gets
  // the screen alone — the tooth is what makes a web-sized picture read as a
  // printed plate rather than a soft JPEG.
  const figure = plate ? [] : MOTIF_LAYERS[motif](colors.slice(), d)

  // Half the figures leave the ground showing as negative space, which is the
  // drawing when the art is a plate in the middle of a panel — and an empty
  // cover when the art *is* the panel. So a full-bleed cover gets a flat field
  // behind everything for the figure to sit on.
  const field =
    layout === 'full' && !plate ? [...figure, fill(`linear-gradient(${darkest(colors)} 0 100%)`)] : figure
  const layers = [...SCREEN_LAYERS[screen](SCREEN_INK, d), ...field]

  return {
    palette,
    colors,
    motif,
    layout,
    screen,
    accent: colors[0],
    stack: layers,
    layers: layers.map((l) => l.image).join(', '),
    sizes: layers.map((l) => l.size).join(', '),
    positions: layers.map((l) => l.pos).join(', '),
    repeats: layers.map((l) => l.repeat).join(', '),
    plate,
  }
}

// ── Choosing a photograph ────────────────────────────────────────────────────

/**
 * A 7" panel at Lulu's 300 PPI is 2100px. Nothing extracted from the web comes
 * that big, so the bar is the width at which a picture, screened and printed
 * across the panel, still reads as a photograph rather than as pixels: 1600px
 * is ~230 PPI at 7 inches, which a halftone hides and a bare enlargement does
 * not. Below it the cover is drawn instead.
 */
export const PLATE_MIN_WIDTH = 1600
/** Portrait art crops to nothing across a landscape-ish art box. */
export const PLATE_MIN_RATIO = 1.1

export interface PlateCandidate {
  path: string
  width: number | null
  height: number | null
  alt?: string | null
  caption?: string | null
  /** The publication the picture came in with, for the credit line. */
  sourceName?: string | null
}

/**
 * The best photograph in an issue, or null when none of them can carry a
 * cover. Deliberately strict: a soft cover is worse than a drawn one, and the
 * drawn one is always available.
 */
export function plateFor(candidates: PlateCandidate[]): PlateCandidate | null {
  const usable = candidates.filter(
    (c) =>
      c.width !== null &&
      c.height !== null &&
      c.width >= PLATE_MIN_WIDTH &&
      c.width / c.height >= PLATE_MIN_RATIO,
  )
  if (usable.length === 0) return null
  // The biggest one: at this size the pixel count is the whole argument.
  return usable.reduce((best, c) => ((c.width ?? 0) > (best.width ?? 0) ? c : best))
}
