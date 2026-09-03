import { describe, it, expect } from 'vitest'
import { isLoopback } from '../auth'

describe('isLoopback', () => {
  it('recognises a dev server', () => {
    for (const host of ['localhost:3000', 'localhost', '127.0.0.1:3001', '[::1]:3000', 'LOCALHOST:3000']) {
      expect(isLoopback(host)).toBe(true)
    }
  })

  it('does not recognise anything reachable from elsewhere', () => {
    // A tunnel is the case that matters: pointing one at a dev server makes it
    // internet-reachable, and the old password's own comment said an obscure
    // URL is not a password. It should ask for a session, as that did.
    for (const host of [
      'earmarked.vercel.app',
      '192.168.1.230:3000',
      'quiet-otter-42.trycloudflare.com',
      'localhost.example.com',
      'notlocalhost',
      'evil.com:3000',
      '127.0.0.1.example.com',
      '',
      null,
    ]) {
      expect(isLoopback(host)).toBe(false)
    }
  })
})
