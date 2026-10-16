/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest'

import { canAskForMicrophone } from '@/lib/voice-call'

const setPage = ({ secureContext, mediaDevices }: { secureContext: boolean; mediaDevices: unknown }) => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: secureContext })
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices })
}

describe('whether a page can ask for the microphone', () => {
  afterEach(() => {
    setPage({ secureContext: false, mediaDevices: undefined })
  })

  it('can on a secure page with the media devices API', () => {
    setPage({ secureContext: true, mediaDevices: { getUserMedia: async () => ({}) } })

    expect(canAskForMicrophone()).toBe(true)
  })

  it('cannot on a page served over plain http, which browsers never give a microphone', () => {
    setPage({ secureContext: false, mediaDevices: { getUserMedia: async () => ({}) } })

    expect(canAskForMicrophone()).toBe(false)
  })

  it('cannot where the browser has no media devices API', () => {
    setPage({ secureContext: true, mediaDevices: undefined })

    expect(canAskForMicrophone()).toBe(false)
  })
})
