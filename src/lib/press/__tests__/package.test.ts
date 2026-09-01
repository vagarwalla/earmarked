import { describe, it, expect } from 'vitest'
import { LULU_PACKAGE_ID, describePackage } from '../types'

describe('describePackage', () => {
  it('decodes the package press actually orders', () => {
    const spec = describePackage(LULU_PACKAGE_ID)
    expect(spec).toMatchObject({
      trim: '7 × 10 in',
      colour: 'Full colour',
      quality: 'Standard',
      binding: 'Perfect bound',
      paper: '60# uncoated white (444 ppi)',
      coverFinish: 'Gloss laminate',
      raw: LULU_PACKAGE_ID,
    })
  })

  it('defaults to the configured package', () => {
    expect(describePackage().raw).toBe(LULU_PACKAGE_ID)
  })

  it('reads a trim that is not a whole number of inches', () => {
    expect(describePackage('0850X1100.FC.STD.PB.080CW444.GXX').trim).toBe('8.5 × 11 in')
  })

  it('reads other bindings and finishes', () => {
    const coil = describePackage('0700X1000.BW.PRE.CO.060UW444.MXX')
    expect(coil.binding).toBe('Coil bound')
    expect(coil.colour).toBe('Black and white')
    expect(coil.quality).toBe('Premium')
    expect(coil.coverFinish).toBe('Matte laminate')
    expect(coil.paper).toBe('60# uncoated white (444 ppi)')
  })

  /**
   * The point of the fallbacks: a confident wrong answer about what is being
   * printed is worse than an unfamiliar code shown as-is.
   */
  it('passes through codes it does not recognise rather than guessing', () => {
    const spec = describePackage('0700X1000.XX.YYY.ZZ.999QQ111.WXX')
    expect(spec.colour).toBe('XX')
    expect(spec.quality).toBe('YYY')
    expect(spec.binding).toBe('ZZ')
    expect(spec.coverFinish).toBe('WXX')
    expect(spec.paper).toBe('999QQ111')
  })

  it('does not invent fields for a malformed id', () => {
    const spec = describePackage('nonsense')
    expect(spec.trim).toBe('nonsense')
    expect(spec.raw).toBe('nonsense')
    expect(spec.binding).toBe('—')
  })
})
