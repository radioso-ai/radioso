import { describe, expect, it } from 'vitest'

import {
  voiceConnectionFailureMessage,
  voiceVendorKeyProblemOfConnection,
  voiceVendorKeyProblemOfError,
} from '@/lib/voice-connection-failures'

const apiError = (code: string) => ({ status: 409, error: { code, message: 'Switch failed' } })

describe('which failed voice switch asks for the vendor key', () => {
  it('asks for every failure a working key fixes', () => {
    expect(voiceVendorKeyProblemOfError(apiError('voice_vendor_key_missing'))).toBe('missing')
    expect(voiceVendorKeyProblemOfError(apiError('voice_vendor_key_unreadable'))).toBe('unreadable')
    expect(voiceVendorKeyProblemOfError(apiError('voice_vendor_key_rejected'))).toBe('rejected')
    expect(voiceVendorKeyProblemOfError(apiError('voice_vendor_key_lacks_agents_permission'))).toBe('lacks_agents_permission')
  })

  it('names any other failure inline instead', () => {
    expect(voiceVendorKeyProblemOfError(apiError('voice_connection_busy'))).toBeNull()
    expect(voiceVendorKeyProblemOfError(new Error('offline'))).toBeNull()
    expect(voiceConnectionFailureMessage(apiError('voice_vendor_unreachable'), 'ElevenLabs', 'Failed to turn voice on.'))
      .toBe('ElevenLabs didn’t answer. Try again in a moment.')
    expect(voiceConnectionFailureMessage({}, 'ElevenLabs', 'Failed to turn voice on.')).toBe('Failed to turn voice on.')
  })
})

describe('a voice switch that went on', () => {
  it('asks for the key when the workspace has no usable one', () => {
    expect(voiceVendorKeyProblemOfConnection({ vendorKey: 'stored' })).toBeNull()
    expect(voiceVendorKeyProblemOfConnection({ vendorKey: 'missing' })).toBe('missing')
    expect(voiceVendorKeyProblemOfConnection({ vendorKey: 'unreadable' })).toBe('unreadable')
  })
})
