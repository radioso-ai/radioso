// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OperatorActionBar } from '@/components/dashboard/operator-action-bar'
import { hitlApi } from '@/lib/api-hitl'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

const render = async (ownership: { state: 'ai_owned' | 'human_owned'; version: number }, onChanged = vi.fn()) => {
  const root = createRoot(document.createElement('div'))
  const container = (root as unknown as { _internalRoot: { containerInfo: HTMLElement } })._internalRoot.containerInfo
  await act(async () => { root.render(<OperatorActionBar conversationId="conversation-a" ownership={ownership as never} pendingDecisions={[]} onChanged={onChanged} />) })
  return { root, container, onChanged }
}

afterEach(() => vi.restoreAllMocks())

describe('OperatorActionBar outcomes', () => {
  const decision = {
    agentId: 'agent-a',
    handle: 'decision-a',
    reason: 'Approve this action',
    options: [{ id: 'approve', label: 'Approve' }],
    contentHash: 'hash-a',
    canResolve: true,
  } as never

  it('uses authoritative takeover and handback ownership results', async () => {
    const takeover = vi.spyOn(hitlApi, 'takeOverConversation').mockResolvedValue({ ownership: { state: 'human_owned' } } as never)
    const changed = vi.fn()
    const first = await render({ state: 'ai_owned', version: 1 }, changed)
    await act(async () => { first.container.querySelector('button')?.click(); await flush() })
    expect(takeover).toHaveBeenCalled()
    expect(changed).toHaveBeenCalledWith({ kind: 'ownership', conversationId: 'conversation-a', ownershipState: 'human_owned' })
    await act(async () => first.root.unmount())

    const handback = vi.spyOn(hitlApi, 'handBackConversation').mockResolvedValue({ ownership: { state: 'ai_owned' } } as never)
    const second = await render({ state: 'human_owned', version: 2 }, changed)
    await act(async () => { [...second.container.querySelectorAll('button')].find((button) => button.textContent?.includes('Hand back'))?.click(); await flush() })
    expect(handback).toHaveBeenCalled()
    expect(changed).toHaveBeenLastCalledWith({ kind: 'ownership', conversationId: 'conversation-a', ownershipState: 'ai_owned' })
    await act(async () => second.root.unmount())
  })

  it('emits reply without ownership and refreshes 409/422 with their messages', async () => {
    const reply = vi.spyOn(hitlApi, 'replyAsHuman').mockResolvedValue({ message: {} } as never)
    const changed = vi.fn()
    const view = await render({ state: 'human_owned', version: 1 }, changed)
    const textarea = view.container.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'hi')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
    })
    await act(async () => { [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('Send reply'))?.click(); await flush() })
    expect(reply).toHaveBeenCalled()
    expect(changed).toHaveBeenCalledWith({ kind: 'reply', conversationId: 'conversation-a' })
    await act(async () => view.root.unmount())
  })

  it('maps a takeover 409 to one specific refresh outcome without ownership success', async () => {
    vi.spyOn(hitlApi, 'takeOverConversation').mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }))
    const changed = vi.fn()
    const view = await render({ state: 'ai_owned', version: 1 }, changed)
    await act(async () => { view.container.querySelector('button')?.click(); await flush() })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith({ kind: 'refresh', conversationId: 'conversation-a', reason: 'conflict' })
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('conversation changed')
    await act(async () => view.root.unmount())
  })

  it('maps a decision 422 to one invalid-option refresh without decision success', async () => {
    vi.spyOn(hitlApi, 'resolveDecision').mockRejectedValue(Object.assign(new Error('invalid'), { status: 422 }))
    const changed = vi.fn()
    const view = await render({ state: 'ai_owned', version: 1 }, changed)
    await act(async () => {
      view.root.render(<OperatorActionBar conversationId="conversation-a" ownership={{ state: 'ai_owned', version: 1 } as never} pendingDecisions={[decision]} onChanged={changed} />)
      await flush()
    })
    await act(async () => { [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Approve')?.click(); await flush() })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith({ kind: 'refresh', conversationId: 'conversation-a', reason: 'invalid_option' })
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('option is no longer valid')
    await act(async () => view.root.unmount())
  })
})
