/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildCopilotProposalDiff, CopilotProposalCard, targetReference } from '@/components/dashboard/copilot-proposal-card'
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

  it('resolves a context variable proposal to its agent, the same way an agent setting proposal does', () => {
    // A context variable's definition is workspace-scoped, not agent-scoped, so there is no
    // per-variable dashboard page to deep-link to yet — the card links to the agent that proposed
    // it, exactly like agent_setting.
    const proposal: CopilotProposalSummary = {
      id: 'proposal-context-variable',
      targetType: 'context_variable',
      targetLabel: 'loyalty_tier',
      summary: 'Add a loyalty_tier context variable',
      status: 'pending',
    }

    expect(targetReference(proposal, { targetRef: { agentId: 'agent-1', variableId: null } } as CopilotProposalDetail, null)).toEqual({
      entity: { type: 'agent', id: 'agent-1' },
      agentId: 'agent-1',
    })

    // Live-apply path: no detail ever loaded, apply response alone carries the agent id.
    expect(targetReference(proposal, null, { agentId: 'agent-9', variableId: 'variable-applied' })).toEqual({
      entity: { type: 'agent', id: 'agent-9' },
      agentId: 'agent-9',
    })

    expect(targetReference(proposal, null, null)).toBeNull()
  })

  it('renders a directive removal preview as one legible row instead of every field marked blank', () => {
    // Without a fix, a record-shaped `current` next to a null/undefined `proposed` recurses through
    // the generic diff algorithm and expands into one row per field, each showing "current value"
    // next to "—". A single sentinel string on the proposed side keeps the removal to one row.
    const current = {
      id: 'directive-1',
      name: 'Avoid competitors',
      condition: { kind: 'always' },
      action: 'Say nothing about rivals.',
      tags: ['sales'],
    }

    const rows = buildCopilotProposalDiff({ current, proposed: 'This directive will be permanently removed.' })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.current).toEqual(current)
    expect(rows[0]?.proposed).toBe('This directive will be permanently removed.')
  })

  it('shows no rows for an untouched half of a preview once the source echoes it identically on both sides', () => {
    // This is the shape createContextVariableCopilotProposalAdapter's preview now returns for a
    // definition-only proposal: the untouched enablement is echoed forward as the same value on
    // both sides, not the stored payload's literal null - see the next test for why that
    // distinction matters to this diff algorithm.
    const enablement = { source: 'pushed', resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: 'on_reference', enabled: true }
    const current = { definition: { name: 'loyalty_tier', sensitivity: 'normal' }, enablement }
    const proposed = { definition: { name: 'loyalty_tier', sensitivity: 'sensitive' }, enablement }

    const rows = buildCopilotProposalDiff({ current, proposed })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path: '$.definition.sensitivity', current: 'normal', proposed: 'sensitive' })
  })

  it('would render an untouched half as a full removal if a preview passed its literal null through instead of echoing the current value', () => {
    // Documents the bug the preceding test's projection prevents: a record-shaped
    // `current.enablement` next to a null `proposed.enablement` (a stored payload's "not part of
    // this proposal" marker, taken literally) recurses through the generic diff and expands into
    // one removed row per enablement field - a removal that will not actually happen on Apply.
    const enablement = { source: 'pushed', resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: 'on_reference', enabled: true }
    const current = { definition: { name: 'loyalty_tier' }, enablement }
    const proposed = { definition: { name: 'loyalty_tier' }, enablement: null }

    const rows = buildCopilotProposalDiff({ current, proposed })

    expect(rows.length).toBeGreaterThan(1)
    expect(rows.every((row) => row.path.startsWith('$.enablement.'))).toBe(true)
    expect(rows.every((row) => row.kind === 'removed')).toBe(true)
  })
})
