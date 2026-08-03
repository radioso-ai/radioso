import { describe, expect, it } from 'vitest'

import { getAgentOperatorLabel, getAgentPublicNameHint } from '@/lib/agent-label'

describe('operator agent labels', () => {
  it('prefers a trimmed internal label and exposes the public name as a hint', () => {
    const agent = { internalName: '  Italian support  ', name: 'Claudio' }

    expect(getAgentOperatorLabel(agent)).toBe('Italian support')
    expect(getAgentPublicNameHint(agent)).toBe('Claudio')
  })

  it('falls back through the public name and supplied fallback', () => {
    expect(getAgentOperatorLabel({ name: '  Claudio  ' })).toBe('Claudio')
    expect(getAgentOperatorLabel({ internalName: '   ', name: '   ' }, 'Unknown agent')).toBe('Unknown agent')
    expect(getAgentOperatorLabel(null, 'No agent')).toBe('No agent')
  })

  it('does not expose a redundant public name hint', () => {
    expect(getAgentPublicNameHint({ internalName: 'Claudio', name: 'Claudio' })).toBeNull()
    expect(getAgentPublicNameHint({ name: 'Claudio' })).toBeNull()
    expect(getAgentPublicNameHint(undefined)).toBeNull()
  })
})
