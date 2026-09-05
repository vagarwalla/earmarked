import { describe, it, expect } from 'vitest'
import { thriftBooksCartLink, isThriftBooksCartLink, mergeThriftBooksCartLinks, THRIFTBOOKS_BOOKMARKLET } from '../thriftbooksCart'

describe('ThriftBooks cart links', () => {
  it('builds and recognises a cart-page link', () => {
    const url = thriftBooksCartLink(5116306)
    expect(url).toBe('https://www.thriftbooks.com/shopping-cart/#earmarked=5116306:1')
    expect(isThriftBooksCartLink(url)).toBe(true)
    expect(isThriftBooksCartLink('https://www.thriftbooks.com/shopping-cart/')).toBe(false)
    expect(isThriftBooksCartLink('https://www.abebooks.com/checkout/basket?ac=a&ik=1')).toBe(false)
  })

  it('merges every ThriftBooks copy into one link, summing repeats, and leaves other links alone', () => {
    const merged = mergeThriftBooksCartLinks([
      'https://www.abebooks.com/checkout/basket?ac=a&ik=1',
      thriftBooksCartLink(10),
      thriftBooksCartLink(20),
      thriftBooksCartLink(10),
      'https://www.abebooks.com/checkout/basket?ac=a&ik=2',
    ])
    expect(merged).toEqual([
      'https://www.abebooks.com/checkout/basket?ac=a&ik=1',
      'https://www.thriftbooks.com/shopping-cart/#earmarked=10:2,20:1',
      'https://www.abebooks.com/checkout/basket?ac=a&ik=2',
    ])
  })

  it('passes a list with no ThriftBooks links through untouched', () => {
    const urls = ['https://example.test/a', 'https://example.test/b']
    expect(mergeThriftBooksCartLinks(urls)).toBe(urls)
  })

  it('ships a bookmarklet that posts to ThriftBooks\' own cart call', () => {
    expect(THRIFTBOOKS_BOOKMARKLET.startsWith('javascript:')).toBe(true)
    const code = decodeURIComponent(THRIFTBOOKS_BOOKMARKLET.slice('javascript:'.length))
    expect(code).toContain("fetch('/api/cart/addtocart'")
    expect(code).toContain("credentials:'include'")
    expect(code).not.toContain('\n')
  })
})
