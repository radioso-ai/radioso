import { describe, expect, it } from 'vitest'

import { getMemberCountDelta } from '@/components/dashboard/audience-pulse-view'
import type { AudiencePulseTheme } from '@/lib/api-audience-pulse'

const theme = (overrides: Partial<AudiencePulseTheme>): AudiencePulseTheme => ({
  id: 'theme-1',
  title: 'Refund timing',
  description: 'Questions about refund timelines.',
  memberCount: 40,
  previousMemberCount: 40,
  previousShare: 0.2,
  transition: { kind: 'survived', parentTopicIds: ['prior-theme-1'], viaCentroidFallback: false },
  share: 0.2,
  distinctQuestionCount: 2,
  weeklyPulse: [],
  grounding: { grounded: 0, degraded: 0, noSupport: 0, unknown: 0, contentGapEligible: 0 },
  evidence: [],
  ...overrides,
})

describe('getMemberCountDelta', () => {
  it('uses the report materiality threshold when count and share both grow', () => {
    expect(getMemberCountDelta(theme({ memberCount: 47, share: 0.24 }), 0.2, 0.2)).toBeNull()
    expect(getMemberCountDelta(theme({ memberCount: 49, share: 0.24 }), 0.2, 0.2)).toBe('up from 40')
  })

  it('changes what renders when the report publishes a different threshold', () => {
    const growingTheme = theme({ memberCount: 49, share: 0.24 })

    expect(getMemberCountDelta(growingTheme, 0.2, 0.2)).toBe('up from 40')
    expect(getMemberCountDelta(growingTheme, 0.2, 0.25)).toBeNull()
  })

  it('renders a decrease only when share also falls', () => {
    expect(getMemberCountDelta(theme({ memberCount: 32, share: 0.12 }), 0.2, 0.2)).toBe('down from 40')
  })

  it('does not infer a direction from raw counts when share history is missing or disagrees', () => {
    expect(getMemberCountDelta(theme({ memberCount: 48, share: 0.12 }), 0.4, 0.2)).toBeNull()
    expect(getMemberCountDelta(theme({ memberCount: 32, share: 0.8 }), 0.4, 0.2)).toBeNull()
    expect(getMemberCountDelta(theme({ memberCount: 96, share: 0.4 }), null, 0.2)).toBeNull()
    expect(getMemberCountDelta(theme({ memberCount: 96, share: 0.4, transition: null }), 0.2, 0.2)).toBeNull()
  })

  it.each(['emerged', 'split', 'merged'] as const)(
    'does not render a delta for a %s transition even when count and share would otherwise grow',
    (kind) => {
      expect(getMemberCountDelta(
        theme({
          memberCount: 96,
          share: 0.4,
          transition: { kind, parentTopicIds: ['prior-theme-1'], viaCentroidFallback: false },
        }),
        0.2,
        0.2,
      )).toBeNull()
    },
  )
})
