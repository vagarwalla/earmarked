/**
 * press — the layout cost estimate.
 *
 * Pinned against the real Lulu quotes it was fitted to (2026-09-05, 7×10 full
 * colour, MAIL). The tolerances are the point: this is for choosing between
 * layouts, so being a few cents out on a $100 parcel is fine and being wrong
 * about *which* layout is cheaper is not.
 */

import { describe, it, expect } from 'vitest'
import { estimateCost, costSummary, money } from '../cost'

describe('estimateCost', () => {
  it('matches Lulu on the layout it was fitted to', () => {
    // The eight issues as they stand: quoted at print $85.80 + ship $11.49.
    const actual = estimateCost([102, 62, 160, 140, 164, 126, 172, 172])
    expect(actual.printCents).toBeCloseTo(8580, -2)
    expect(actual.shippingCents).toBeCloseTo(1149, -2)
  })

  it('matches Lulu on a 100-page ceiling too', () => {
    // The same articles repacked into fourteen: quoted at $101.65 + $15.84.
    const capped = [94, 98, 62, 90, 72, 64, 88, 80, 96, 86, 94, 82, 88, 32]
    const actual = estimateCost(capped)
    expect(actual.printCents).toBeCloseTo(10165, -2)
    expect(actual.shippingCents).toBeCloseTo(1584, -2)
  })

  /**
   * The whole reason the estimate exists: it has to get the *direction* right
   * even where it is a dollar out on the amount.
   */
  it('says splitting a book costs money and moving pages does not', () => {
    const whole = estimateCost([200])
    const split = estimateCost([100, 100])
    expect(split.totalCents).toBeGreaterThan(whole.totalCents)

    // Same books, same pages, differently distributed: identical.
    expect(estimateCost([150, 50]).totalCents).toBe(estimateCost([100, 100]).totalCents)
  })

  it('costs nothing to print nothing', () => {
    expect(estimateCost([])).toEqual({
      books: 0,
      pages: 0,
      printCents: 0,
      shippingCents: 0,
      totalCents: 0,
    })
  })
})

describe('money', () => {
  it('reads like a price, negative included', () => {
    expect(money(9804)).toBe('$98.04')
    expect(money(-2020)).toBe('-$20.20')
    expect(money(0)).toBe('$0.00')
  })
})

describe('costSummary', () => {
  it('says where the money went', () => {
    expect(costSummary(estimateCost([100, 100]))).toContain('2 books, 200pp')
  })
})
