/* @vitest-environment jsdom */

import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { RoutineDocumentTab } from '@/components/dashboard/settings/routine-document-tab'
import { RoutineSkillCatalogContext } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import type { RoutineDefinitionDraft } from '@/lib/api'

const newRoutineDraft: RoutineDefinitionDraft = {
  name: 'X',
  activation: { triggerDescription: 'When a customer needs help', priority: 0 },
  slots: [],
  steps: [{ stableStepId: 'step_1', kind: 'chat', instruction: '', toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
  transitions: [],
  terminals: [],
}

function FeedbackHarness({ onDraftChange }: { onDraftChange: (draft: RoutineDefinitionDraft) => void }) {
  const [draft, setDraft] = useState(newRoutineDraft)
  const echoOrder = useRef(0)

  return (
    <RoutineSkillCatalogContext.Provider value={{ agentId: '', skills: [], isLoading: false, error: null }}>
      <RoutineDocumentTab
        draft={draft}
        isReadOnly={false}
        onDraftChange={(next) => {
          onDraftChange(next)
          const delay = echoOrder.current++ === 0 ? 10 : 0
          window.setTimeout(() => setDraft(next), delay)
        }}
      />
    </RoutineSkillCatalogContext.Provider>
  )
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('RoutineDocumentTab', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.useRealTimers()
  })

  it('mounts an editable new routine without entering an update loop', () => {
    const onDraftChange = vi.fn()

    expect(() => {
      act(() => {
        root.render(
          <RoutineSkillCatalogContext.Provider value={{ agentId: '', skills: [], isLoading: false, error: null }}>
            <RoutineDocumentTab draft={newRoutineDraft} isReadOnly={false} onDraftChange={onDraftChange} />
          </RoutineSkillCatalogContext.Provider>,
        )
      })
    }).not.toThrow()

    expect(onDraftChange).not.toHaveBeenCalled()
  })

  it('settles when document edits feed back into the parent draft', () => {
    const onDraftChange = vi.fn()

    expect(() => {
      act(() => {
        root.render(<FeedbackHarness onDraftChange={onDraftChange} />)
      })
    }).not.toThrow()

    expect(onDraftChange.mock.calls.length).toBeLessThan(5)
  })

  it('keeps rapid document edits when an older parent echo arrives last', async () => {
    vi.useFakeTimers()
    const onDraftChange = vi.fn()

    act(() => {
      root.render(<FeedbackHarness onDraftChange={onDraftChange} />)
    })

    const activationTrigger = container.querySelector<HTMLTextAreaElement>('[aria-label="Activation trigger"]')
    const addSlotButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Slot'))
    expect(activationTrigger).toBeTruthy()
    expect(addSlotButton).toBeTruthy()

    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setValue?.call(activationTrigger, 'When a customer asks for a refund')
      activationTrigger?.dispatchEvent(new Event('input', { bubbles: true }))
      addSlotButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    const finalEmittedDraft = onDraftChange.mock.calls.at(-1)?.[0] as RoutineDefinitionDraft
    expect(finalEmittedDraft.activation.triggerDescription).toBe('When a customer asks for a refund')
    expect(finalEmittedDraft.slots).toHaveLength(1)
    expect(container.querySelector('[aria-label="Activation trigger"]')).toHaveProperty('value', 'When a customer asks for a refund')
    expect(container.querySelector('[aria-label^="Slot "]')).not.toBeNull()
  })
})
