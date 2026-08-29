/* @vitest-environment jsdom */

import { describe, expect, it } from 'vitest'

import { playInboxChime } from '@/lib/inbox-chime'

describe('playInboxChime', () => {
  it('does not throw when the Web Audio API is unavailable', () => {
    // jsdom provides no AudioContext; this is exactly the "silently ignore" path
    // the module documents (also covers real autoplay-policy rejections).
    expect(() => playInboxChime()).not.toThrow()
  })
})
