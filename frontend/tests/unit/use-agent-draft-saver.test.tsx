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

  it('registers nothing without an agent', async () => {
    const save = vi.fn(async () => undefined)
    render({ id: undefined, save, isDirty: true })

    await expect(saveAgentDraft(agentId)).rejects.toThrow('not ready')
    pressSaveDraft(agentId)
    expect(save).not.toHaveBeenCalled()
  })
})
