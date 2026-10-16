import { describe, expect, it } from 'vitest'

import { voiceCallReadiness, voiceCallReadinessHint } from '@/lib/voice-call-readiness'

const bound = { enabled: true, runtime: { vendor: 'elevenlabs' as const, agentId: 'agent_42', region: 'us' as const } }

describe('voice call readiness', () => {
  it('is ready when voice is on, a runtime is bound and the workspace stores its vendor key', () => {
    expect(voiceCallReadiness({ voice: bound, storedProviders: ['openai', 'elevenlabs'] })).toEqual({ ready: true })
  })

  it('names the first missing piece, in the order an operator sets them up', () => {
    expect(voiceCallReadiness({ voice: { ...bound, enabled: false, runtime: null }, storedProviders: [] })).toEqual({ ready: false, missing: 'voice_channel' })
    expect(voiceCallReadiness({ voice: { ...bound, runtime: null }, storedProviders: ['elevenlabs'] })).toEqual({ ready: false, missing: 'runtime' })
    expect(voiceCallReadiness({ voice: bound, storedProviders: ['openai'] })).toEqual({ ready: false, missing: 'vendor_key', vendorName: 'ElevenLabs' })
  })

  it('names every piece when the stored keys cannot be read', () => {
    const readiness = voiceCallReadiness({ voice: bound, storedProviders: null })

    expect(readiness).toEqual({ ready: false, missing: 'unknown' })
    expect(voiceCallReadinessHint({ ready: false, missing: 'unknown' })).toBe('Turn on the voice channel, bind a runtime and store the vendor key first.')
  })

  it('points at the vendor key by the vendor’s name', () => {
    expect(voiceCallReadinessHint({ ready: false, missing: 'vendor_key', vendorName: 'ElevenLabs' })).toBe('Store the ElevenLabs key under Settings → Providers first.')
  })
})
