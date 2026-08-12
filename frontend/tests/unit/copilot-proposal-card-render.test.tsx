/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { CopilotProposalCard } from '@/components/dashboard/copilot-proposal-card'

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
})
