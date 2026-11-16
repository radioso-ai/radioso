/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  AUDIENCE_PULSE_EVIDENCE_HANDOFF_KEY,
  clearAudiencePulseEvidenceHandoff,
  consumeAudiencePulseEvidenceHandoff,
  evidenceAnchorContent,
  writeAudiencePulseEvidenceHandoff,
} from '@/lib/audience-pulse-evidence-handoff'

const scope = { accountId: 'account-1', workspaceId: 'workspace-1' }

describe('evidenceAnchorContent', () => {
  it('shows a visitor message as its typed words and photo count, and a reply as it is', () => {
    expect(evidenceAnchorContent({ content: 'Something like this', photoCount: 2 })).toBe('Something like this · 2 photos')
    expect(evidenceAnchorContent({ content: '', photoCount: 1 })).toBe('1 photo')
    expect(evidenceAnchorContent({ content: 'Which plan includes exports?', photoCount: 0 })).toBe('Which plan includes exports?')
    expect(evidenceAnchorContent({ content: 'Which plan includes exports?' })).toBe('Which plan includes exports?')
    expect(evidenceAnchorContent({ content: 'The Pro plan does.' })).toBe('The Pro plan does.')
  })
})

describe('audience-pulse-evidence-handoff', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('round-trips an account/workspace-scoped evidence selection and clears it', () => {
    writeAudiencePulseEvidenceHandoff({
      ...scope,
      evidence: { conversationId: 'conversation-1', messageId: 'message-1' },
    })

    expect(consumeAudiencePulseEvidenceHandoff(scope)).toEqual({
      conversationId: 'conversation-1',
      messageId: 'message-1',
    })
    expect(window.sessionStorage.getItem(AUDIENCE_PULSE_EVIDENCE_HANDOFF_KEY)).toBeNull()
  })

  it('discards a mismatched handoff and clears it from storage', () => {
    writeAudiencePulseEvidenceHandoff({
      accountId: scope.accountId,
      workspaceId: 'workspace-2',
      evidence: { conversationId: 'conversation-1', messageId: 'message-1' },
    })

    expect(consumeAudiencePulseEvidenceHandoff(scope)).toBeNull()
    expect(window.sessionStorage.getItem(AUDIENCE_PULSE_EVIDENCE_HANDOFF_KEY)).toBeNull()
  })

  it('clears malformed handoffs without selecting a conversation', () => {
    window.sessionStorage.setItem(AUDIENCE_PULSE_EVIDENCE_HANDOFF_KEY, '{not-json')

    expect(consumeAudiencePulseEvidenceHandoff(scope)).toBeNull()
    expect(window.sessionStorage.getItem(AUDIENCE_PULSE_EVIDENCE_HANDOFF_KEY)).toBeNull()
  })

  it('clears an unconsumed handoff when another Activity selection supersedes it', () => {
    writeAudiencePulseEvidenceHandoff({
      ...scope,
      evidence: { conversationId: 'conversation-1', messageId: 'message-1' },
    })

    clearAudiencePulseEvidenceHandoff()

    expect(window.sessionStorage.getItem(AUDIENCE_PULSE_EVIDENCE_HANDOFF_KEY)).toBeNull()
  })
})
