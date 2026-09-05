import { describe, it, expect } from 'vitest'
import { searchTitles } from '../import/route'

describe('searchTitles', () => {
  it('tries the full title first', () => {
    expect(searchTitles('Neuromancer')).toEqual(['Neuromancer'])
  })

  it('falls back to the part before a subtitle', () => {
    // Open Library misses on the full jacket title but finds the short form
    expect(searchTitles('The Splendid and the Vile: A Saga of Churchill, Family, and Defiance During the Blitz'))
      .toEqual([
        'The Splendid and the Vile: A Saga of Churchill, Family, and Defiance During the Blitz',
        'The Splendid and the Vile',
      ])
  })

  it('treats an em dash as a subtitle separator too', () => {
    expect(searchTitles('Sapiens — A Brief History of Humankind')).toEqual([
      'Sapiens — A Brief History of Humankind',
      'Sapiens',
    ])
  })

  it('does not fall back to a title too short to identify a book', () => {
    // "It: A Novel" must not go looking for every work called "It"
    expect(searchTitles('It: A Novel')).toEqual(['It: A Novel'])
  })

  it('leaves a colon-free title alone', () => {
    expect(searchTitles('All the Light We Cannot See')).toEqual(['All the Light We Cannot See'])
  })
})
