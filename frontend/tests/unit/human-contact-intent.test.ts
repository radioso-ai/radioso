import { describe, expect, it } from 'vitest'

import { isHumanContactRequest } from '@/lib/human-contact-intent'

describe('human contact intent detection', () => {
  it.each([
    'contact a person',
    'Can I talk to a human?',
    'please connect me with support',
    'I want to speak with an agent',
  ])('detects explicit handoff requests: %s', (message) => {
    expect(isHumanContactRequest(message)).toBe(true)
  })

  it.each([
    'what is the contact email in this document?',
    'summarize the support section',
    'what does this person say in the transcript?',
    'contact details are missing from the policy',
  ])('ignores normal information requests: %s', (message) => {
    expect(isHumanContactRequest(message)).toBe(false)
  })
})
