/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { CopilotProposalCard, targetReference } from '@/components/dashboard/copilot-proposal-card'
import type { CopilotProposalDetail, CopilotProposalSummary } from '@/lib/api-copilot'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('CopilotProposalCard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('hides Apply unless management permission is explicit', () => {
    act(() => root.render(
      <CopilotProposalCard
        proposal={{
          id: 'proposal-1',
          targetType: 'directive',
          targetLabel: 'Refund policy',
          summary: 'Add a refund rule',
          status: 'pending',
        }}
        canApply={false}
        onOpenEntity={vi.fn()}
      />,
    ))

    const buttonLabels = Array.from(container.querySelectorAll('button')).map((button) => button.textContent)
    expect(buttonLabels).not.toContain('Apply')
    expect(container.textContent).toContain('Dismiss')
  })

  it('resolves routine targets from the applied reference, target reference, or id', () => {
    const proposal: CopilotProposalSummary = {
      id: 'proposal-routine',
      targetType: 'routine',
      targetLabel: 'Refund routine',
      summary: 'Add a refund routine',
      status: 'pending',
    }
    const detail = { targetRef: { agentId: 'agent-1', routineId: 'routine-ref' } } as CopilotProposalDetail

    expect(targetReference(proposal, detail, { routineId: 'routine-applied' })).toEqual({
      entity: { type: 'routine', id: 'routine-applied' },
      agentId: 'agent-1',
    })
    expect(targetReference(proposal, detail, null)).toEqual({
      entity: { type: 'routine', id: 'routine-ref' },
      agentId: 'agent-1',
    })
    expect(targetReference(proposal, { targetRef: { agentId: 'agent-1', id: 'routine-id' } } as CopilotProposalDetail, null)).toEqual({
      entity: { type: 'routine', id: 'routine-id' },
      agentId: 'agent-1',
    })
    // Live-apply path: no detail ever loaded, apply response alone carries both ids.
    expect(targetReference(proposal, null, { agentId: 'agent-9', routineId: 'routine-applied' })).toEqual({
      entity: { type: 'routine', id: 'routine-applied' },
      agentId: 'agent-9',
    })
  })

  it('resolves an agent-skill target only once an id exists, from the applied reference or the target reference', () => {
    const proposal: CopilotProposalSummary = {
      id: 'proposal-skill',
      targetType: 'agent_skill',
      targetLabel: 'notify_ops',
      summary: 'Add a notify skill',
      status: 'pending',
    }

    // A drafted "create" proposal has no skill id until it is applied, so no link renders yet.
    expect(targetReference(proposal, { targetRef: { agentId: 'agent-1', skillId: null } } as CopilotProposalDetail, null)).toBeNull()

    expect(targetReference(proposal, { targetRef: { agentId: 'agent-1', skillId: 'skill-ref' } } as CopilotProposalDetail, null)).toEqual({
      entity: { type: 'agent_skill', id: 'skill-ref' },
      agentId: 'agent-1',
    })

    // Live-apply path: no detail ever loaded, apply response alone carries both ids.
    expect(targetReference(proposal, null, { agentId: 'agent-9', skillId: 'skill-applied' })).toEqual({
      entity: { type: 'agent_skill', id: 'skill-applied' },
      agentId: 'agent-9',
    })
  })
})
