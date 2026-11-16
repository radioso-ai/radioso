import { describe, expect, it } from 'vitest'

import { voiceCallReadinessHint, websiteCallsSwitchOf } from '@/lib/voice-call-readiness'

describe('the voice readiness hint', () => {
  it('names the piece the backend says is missing', () => {
    expect(voiceCallReadinessHint('publication', 'ElevenLabs')).toBe('Publish the agent first: until it is published, it answers no chats or calls.')
    expect(voiceCallReadinessHint('voice_channel', 'ElevenLabs')).toBe('Turn on the voice channel on the API page first.')
    // Nothing bound reads as voice off on the Voice card, whose switch connects.
    expect(voiceCallReadinessHint('runtime', 'ElevenLabs')).toBe('Turn on the voice channel on the API page first.')
    expect(voiceCallReadinessHint('vendor_key', 'ElevenLabs')).toBe('Store the ElevenLabs key under Settings → Providers first.')
    expect(voiceCallReadinessHint('encryption', 'ElevenLabs')).toBe('Radioso cannot read the stored ElevenLabs key. Check CONNECTOR_ENCRYPTION_KEY; after a key rotation, list the key it replaced in CONNECTOR_ENCRYPTION_PREVIOUS_KEYS. Otherwise enter the key again.')
  })

  it('names every step when the page could not learn what is missing', () => {
    expect(voiceCallReadinessHint(undefined, 'ElevenLabs')).toBe('Publish the agent and turn on its voice channel on the API page first.')
  })
})

describe('turning the website calls switch on', () => {
  it('offers calls at once when voice is ready', () => {
    expect(websiteCallsSwitchOf({ ready: true, missing: null }, 'ElevenLabs')).toEqual({ kind: 'ready' })
  })

  it('sets voice up first when the missing piece is one turning voice on fixes', () => {
    expect(websiteCallsSwitchOf({ ready: false, missing: 'voice_channel' }, 'ElevenLabs'))
      .toEqual({ kind: 'sets_up_voice', hint: 'Turning it on sets up the agent’s voice on ElevenLabs.' })
    expect(websiteCallsSwitchOf({ ready: false, missing: 'runtime' }, 'ElevenLabs'))
      .toEqual({ kind: 'sets_up_voice', hint: 'Turning it on connects ElevenLabs for this agent.' })
    expect(websiteCallsSwitchOf({ ready: false, missing: 'vendor_key' }, 'ElevenLabs'))
      .toEqual({ kind: 'sets_up_voice', hint: 'Turning it on asks for the ElevenLabs API key.' })
  })

  it('stays blocked, naming the piece, when the switch cannot set it up or readiness is unknown', () => {
    expect(websiteCallsSwitchOf({ ready: false, missing: 'publication' }, 'ElevenLabs'))
      .toEqual({ kind: 'blocked', hint: 'Publish the agent first: until it is published, it answers no chats or calls.' })
    expect(websiteCallsSwitchOf({ ready: false, missing: 'encryption' }, 'ElevenLabs'))
      .toMatchObject({ kind: 'blocked', hint: expect.stringContaining('CONNECTOR_ENCRYPTION_KEY') })
    expect(websiteCallsSwitchOf(null, 'ElevenLabs'))
      .toEqual({ kind: 'blocked', hint: 'Publish the agent and turn on its voice channel on the API page first.' })
  })
})
