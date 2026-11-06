/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentDraftSaver } from '@/components/dashboard/settings/use-agent-draft-saver'
import { isAgentDraftDirty, saveAgentDraft } from '@/lib/agent-draft-save-port'

const agentId = '22222222-2222-4222-8222-222222222222'

describe('useAgentDraftSaver', () => {
  let container: HTMLDivElement
  let root: Root

  beforeAll(() => {
    // React 19 reads this to decide whether act() may drive updates.
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  const Harness = ({ id, save, isDirty }: { id: string | undefined; save: () => Promise<void>; isDirty: boolean }) => {
    useAgentDraftSaver({ agentId: id, save, isDirty })
    return null
  }

  const render = (props: { id: string | undefined; save: () => Promise<void>; isDirty: boolean }) => {
    act(() => root.render(<Harness {...props} />))
  }

  const pressSaveDraft = (id: string) => {
    window.dispatchEvent(new CustomEvent('radioso:save-agent-draft', { detail: { agentId: id } }))
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('is the agent\'s saver for Test Chat while mounted, and reports whether the page is dirty', async () => {
    const save = vi.fn(async () => undefined)
    render({ id: agentId, save, isDirty: true })

    expect(isAgentDraftDirty(agentId)).toBe(true)
    await saveAgentDraft(agentId)
    expect(save).toHaveBeenCalledOnce()

    render({ id: agentId, save, isDirty: false })
    expect(isAgentDraftDirty(agentId)).toBe(false)

    act(() => root.unmount())
    await expect(saveAgentDraft(agentId)).rejects.toThrow('not ready')
    root = createRoot(container)
  })

  it('saves when the header\'s Save draft is pressed for this agent, and for no other', () => {
    const save = vi.fn(async () => undefined)
    render({ id: agentId, save, isDirty: true })

    pressSaveDraft('33333333-3333-4333-8333-333333333333')
    expect(save).not.toHaveBeenCalled()

    pressSaveDraft(agentId)
    expect(save).toHaveBeenCalledOnce()
  })

  it('leaves a refused save to the page\'s own error state', async () => {
    const save = vi.fn(async () => { throw new Error('refused') })
    render({ id: agentId, save, isDirty: true })

    pressSaveDraft(agentId)
    await Promise.resolve()

    expect(save).toHaveBeenCalledOnce()
  })

  describe('when a save fails', () => {
    const renderWith = (props: { save: () => Promise<void>; isDirty: boolean; onFailureResolved: () => void }) => {
      act(() => root.render(<FailureHarness {...props} />))
    }
    const FailureHarness = (props: { save: () => Promise<void>; isDirty: boolean; onFailureResolved: () => void }) => {
      useAgentDraftSaver({ agentId, ...props })
      return null
    }

    it('lets the page drop the failure once nothing is left unsaved', async () => {
      const onFailureResolved = vi.fn()
      const save = vi.fn(async () => { throw new Error('greeting refused') })
      renderWith({ save, isDirty: true, onFailureResolved })

      await expect(saveAgentDraft(agentId)).rejects.toThrow('greeting refused')
      expect(onFailureResolved).not.toHaveBeenCalled()
      renderWith({ save, isDirty: false, onFailureResolved })

      expect(onFailureResolved).toHaveBeenCalledOnce()
      renderWith({ save, isDirty: true, onFailureResolved })
      renderWith({ save, isDirty: false, onFailureResolved })
      expect(onFailureResolved).toHaveBeenCalledOnce()
    })

    it('lets the page drop the failure when the operator undid the edit while the save was in flight', async () => {
      const onFailureResolved = vi.fn()
      let refuse: (reason: Error) => void = () => undefined
      const save = vi.fn(() => new Promise<void>((_resolve, reject) => { refuse = reject }))
      renderWith({ save, isDirty: true, onFailureResolved })
      const saving = saveAgentDraft(agentId).catch((error: unknown) => error)

      renderWith({ save, isDirty: false, onFailureResolved })
      expect(onFailureResolved).not.toHaveBeenCalled()
      await act(async () => {
        refuse(new Error('greeting refused'))
        await saving
      })

      // Nothing is left to save, so nothing would ever clear the failure the page is showing.
      expect(onFailureResolved).toHaveBeenCalledOnce()
    })

    it('has nothing to drop when the save went through, or when none failed', async () => {
      const onFailureResolved = vi.fn()
      const save = vi.fn(async () => undefined)
      renderWith({ save, isDirty: true, onFailureResolved })

      await saveAgentDraft(agentId)
      renderWith({ save, isDirty: false, onFailureResolved })

      expect(onFailureResolved).not.toHaveBeenCalled()
    })

    it('has nothing to drop when a later save went through', async () => {
      const onFailureResolved = vi.fn()
      const save = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValue(undefined)
      renderWith({ save, isDirty: true, onFailureResolved })

      await expect(saveAgentDraft(agentId)).rejects.toThrow('refused')
      await saveAgentDraft(agentId)
      renderWith({ save, isDirty: false, onFailureResolved })

      expect(onFailureResolved).not.toHaveBeenCalled()
    })
  })

  it('registers nothing without an agent', async () => {
    const save = vi.fn(async () => undefined)
    render({ id: undefined, save, isDirty: true })

    await expect(saveAgentDraft(agentId)).rejects.toThrow('not ready')
    pressSaveDraft(agentId)
    expect(save).not.toHaveBeenCalled()
  })
})
