import { describe, expect, it } from 'vitest'

import { voiceCallReadinessHint } from '@/lib/voice-call-readiness'

describe('the calls switch hint', () => {
  it('names the piece the backend says is missing', () => {
    expect(voiceCallReadinessHint('voice_channel', 'ElevenLabs')).toBe('Turn on the voice channel on the API page first.')
    expect(voiceCallReadinessHint('runtime', 'ElevenLabs')).toBe('Bind a voice runtime on the Voice card first.')
    expect(voiceCallReadinessHint('vendor_key', 'ElevenLabs')).toBe('Store the ElevenLabs key under Settings → Providers first.')
    expect(voiceCallReadinessHint('encryption', 'ElevenLabs')).toBe('Radioso cannot read the stored ElevenLabs key. Set CONNECTOR_ENCRYPTION_KEY, then enter the key again.')
  })

  it('names every piece when the page could not learn what is missing', () => {
    expect(voiceCallReadinessHint(undefined, 'ElevenLabs')).toBe('Turn on the voice channel, bind a runtime and store the vendor key first.')
  })
})
