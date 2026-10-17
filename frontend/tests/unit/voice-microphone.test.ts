/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest'

import { canAskForMicrophone, readMicrophoneSignals } from '@/lib/voice-call'

const secure = { secureContext: true, mediaDevices: true }

describe('whether a page can ask for the microphone', () => {
  it('cannot on a page served over plain http, or without the media devices API', () => {
    expect(canAskForMicrophone({ secureContext: false, mediaDevices: true })).toBe(false)
    expect(canAskForMicrophone({ secureContext: true, mediaDevices: false })).toBe(false)
  })

  it("follows the frame's permissions policy where the browser exposes it", () => {
    expect(canAskForMicrophone({ ...secure, policyAllows: false, permission: 'granted' })).toBe(false)
    expect(canAskForMicrophone({ ...secure, policyAllows: true })).toBe(true)
  })

  it('reads a denied microphone permission as a denied policy where the browser exposes no policy', () => {
    expect(canAskForMicrophone({ ...secure, permission: 'denied' })).toBe(false)
    expect(canAskForMicrophone({ ...secure, permission: 'prompt' })).toBe(true)
    expect(canAskForMicrophone({ ...secure, permission: 'granted' })).toBe(true)
  })

  it('can ask where the browser exposes neither', () => {
    expect(canAskForMicrophone(secure)).toBe(true)
  })
})

describe('the microphone signals a page reads', () => {
  const define = (target: object, key: string, value: unknown) => Object.defineProperty(target, key, { configurable: true, value })
  afterEach(() => {
    define(document, 'featurePolicy', undefined)
    define(navigator, 'permissions', undefined)
    define(navigator, 'mediaDevices', undefined)
    define(window, 'isSecureContext', false)
  })

  it('reads the policy and leaves the permission alone where the policy is exposed', async () => {
    define(window, 'isSecureContext', true)
    define(navigator, 'mediaDevices', { getUserMedia: async () => ({}) })
    define(document, 'featurePolicy', { allowsFeature: (feature: string) => feature !== 'microphone' })
    let queried = false
    define(navigator, 'permissions', { query: async () => { queried = true; return { state: 'granted' } } })

    expect(await readMicrophoneSignals()).toEqual({ secureContext: true, mediaDevices: true, policyAllows: false })
    expect(queried).toBe(false)
  })

  it('asks for the permission state where the policy is not exposed', async () => {
    define(window, 'isSecureContext', true)
    define(navigator, 'mediaDevices', { getUserMedia: async () => ({}) })
    define(navigator, 'permissions', { query: async () => ({ state: 'denied' }) })

    expect(await readMicrophoneSignals()).toEqual({ secureContext: true, mediaDevices: true, permission: 'denied' })
  })

  it('reads neither where the browser does not know the microphone permission', async () => {
    define(window, 'isSecureContext', true)
    define(navigator, 'mediaDevices', { getUserMedia: async () => ({}) })
    define(navigator, 'permissions', { query: async () => { throw new TypeError("'microphone' is not a valid permission name") } })

    expect(await readMicrophoneSignals()).toEqual({ secureContext: true, mediaDevices: true })
  })
})
