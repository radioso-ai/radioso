import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClientId } from '@/lib/client-id'

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')

const setCrypto = (value: Crypto | Record<string, never>) => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value,
  })
}

const restoreCrypto = () => {
  if (originalCryptoDescriptor) {
    Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor)
    return
  }

  delete (globalThis as { crypto?: Crypto }).crypto
}

describe('createClientId', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    restoreCrypto()
  })

  it('uses crypto.randomUUID when available', () => {
    const randomUUID = vi.fn(() => 'uuid-value')
    setCrypto({ randomUUID } as unknown as Crypto)

    expect(createClientId('message')).toBe('uuid-value')
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it('falls back when crypto.randomUUID is unavailable', () => {
    setCrypto({})

    const first = createClientId('message')
    const second = createClientId('message')

    expect(first).toMatch(/^message-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/)
    expect(second).toMatch(/^message-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/)
    expect(second).not.toBe(first)
  })
})
