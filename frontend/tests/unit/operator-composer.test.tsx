// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApprovalDecisionPanel, OperatorComposer } from '@/components/dashboard/operator-composer'
import { hitlApi } from '@/lib/api-hitl'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

const renderComposer = async (ownership: { state: 'ai_owned' | 'human_owned'; version: number }, onChanged = vi.fn()) => {
  const root = createRoot(document.createElement('div'))
  const container = (root as unknown as { _internalRoot: { containerInfo: HTMLElement } })._internalRoot.containerInfo
  await act(async () => {
    root.render(
      <OperatorComposer conversationId="conversation-a" ownership={ownership as never} onChanged={onChanged} />,
    )
  })
  return { root, container, onChanged }
}

const typeInto = async (textarea: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
  })
}

const clickSend = async (container: HTMLElement) => {
  await act(async () => {
    ;[...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Send'))?.click()
    await flush()
  })
}

afterEach(() => vi.restoreAllMocks())

describe('OperatorComposer', () => {
  it('claims an AI-owned conversation on send and reports a single reply outcome', async () => {
    const takeover = vi.spyOn(hitlApi, 'takeOverConversation')
      .mockResolvedValue({ ownership: { state: 'human_owned', version: 2 } } as never)
    const reply = vi.spyOn(hitlApi, 'replyAsHuman').mockResolvedValue({ message: {} } as never)
    const changed = vi.fn()
    const { root, container } = await renderComposer({ state: 'ai_owned', version: 1 }, changed)

    await typeInto(container.querySelector('textarea')!, 'Ciao, come posso aiutarti?')
    await clickSend(container)

    expect(takeover).toHaveBeenCalledWith('conversation-a', {})
    expect(reply).toHaveBeenCalledWith('conversation-a', {
      message: 'Ciao, come posso aiutarti?',
      expectedVersion: 2,
    })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith({ kind: 'reply', conversationId: 'conversation-a' })
    await act(async () => root.unmount())
  })

  it('claims an unclaimed handoff on send, not just an AI-owned conversation', async () => {
    const takeover = vi.spyOn(hitlApi, 'takeOverConversation')
      .mockResolvedValue({ ownership: { state: 'human_owned', version: 3 } } as never)
    const reply = vi.spyOn(hitlApi, 'replyAsHuman').mockResolvedValue({ message: {} } as never)
    const changed = vi.fn()
    // "Awaiting a human": already human_owned, but unclaimed (ownerAccountId null) -
    // still take-over-able, and FR-009 requires claiming it on send too.
    const { root, container } = await renderComposer({ state: 'human_owned', ownerAccountId: null, version: 2 } as never, changed)

    await typeInto(container.querySelector('textarea')!, 'hi')
    await clickSend(container)

    expect(takeover).toHaveBeenCalledWith('conversation-a', {})
    expect(reply).toHaveBeenCalledWith('conversation-a', { message: 'hi', expectedVersion: 3 })
    expect(changed).toHaveBeenCalledWith({ kind: 'reply', conversationId: 'conversation-a' })
    await act(async () => root.unmount())
  })

  it('sends directly against the current version when already claimed by a specific human', async () => {
    const takeover = vi.spyOn(hitlApi, 'takeOverConversation')
    const reply = vi.spyOn(hitlApi, 'replyAsHuman').mockResolvedValue({ message: {} } as never)
    const changed = vi.fn()
    const { root, container } = await renderComposer(
      { state: 'human_owned', ownerAccountId: 'account-other', version: 5 } as never,
      changed,
    )

    await typeInto(container.querySelector('textarea')!, 'hi')
    await clickSend(container)

    expect(takeover).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith('conversation-a', { message: 'hi', expectedVersion: 5 })
    expect(changed).toHaveBeenCalledWith({ kind: 'reply', conversationId: 'conversation-a' })
    await act(async () => root.unmount())
  })

  it('clears the draft only after a successful send', async () => {
    vi.spyOn(hitlApi, 'replyAsHuman').mockResolvedValue({ message: {} } as never)
    const { root, container } = await renderComposer({ state: 'human_owned', version: 1 })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await typeInto(textarea, 'hi there')
    await clickSend(container)

    expect(textarea.value).toBe('')
    await act(async () => root.unmount())
  })

  it('surfaces a conflict and preserves the drafted text on a stale-version send', async () => {
    vi.spyOn(hitlApi, 'takeOverConversation')
      .mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }))
    const changed = vi.fn()
    const { root, container } = await renderComposer({ state: 'ai_owned', version: 1 }, changed)

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await typeInto(textarea, 'my draft reply')
    await clickSend(container)

    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith({ kind: 'refresh', conversationId: 'conversation-a', reason: 'conflict' })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('conversation changed')
    expect(textarea.value).toBe('my draft reply')
    await act(async () => root.unmount())
  })
})

describe('ApprovalDecisionPanel', () => {
  const decision = {
    agentId: 'agent-a',
    handle: 'decision-a',
    reason: 'Approve this action',
    options: [{ id: 'approve', label: 'Approve' }],
    contentHash: 'hash-a',
    canResolve: true,
  } as never

  it('resolves a decision and reports the outcome', async () => {
    const resolve = vi.spyOn(hitlApi, 'resolveDecision').mockResolvedValue({} as never)
    const changed = vi.fn()
    const root = createRoot(document.createElement('div'))
    const container = (root as unknown as { _internalRoot: { containerInfo: HTMLElement } })._internalRoot.containerInfo
    await act(async () => {
      root.render(<ApprovalDecisionPanel conversationId="conversation-a" decision={decision} onChanged={changed} />)
    })

    await act(async () => {
      ;[...container.querySelectorAll('button')].find((button) => button.textContent === 'Approve')?.click()
      await flush()
    })

    expect(resolve).toHaveBeenCalledWith('agent-a', 'decision-a', { optionId: 'approve', contentHash: 'hash-a' })
    expect(changed).toHaveBeenCalledWith({ kind: 'decision_resolved', agentId: 'agent-a', handle: 'decision-a' })
    await act(async () => root.unmount())
  })

  it('maps a 422 to an invalid-option refresh without a decision-resolved outcome', async () => {
    vi.spyOn(hitlApi, 'resolveDecision').mockRejectedValue(Object.assign(new Error('invalid'), { status: 422 }))
    const changed = vi.fn()
    const root = createRoot(document.createElement('div'))
    const container = (root as unknown as { _internalRoot: { containerInfo: HTMLElement } })._internalRoot.containerInfo
    await act(async () => {
      root.render(<ApprovalDecisionPanel conversationId="conversation-a" decision={decision} onChanged={changed} />)
    })

    await act(async () => {
      ;[...container.querySelectorAll('button')].find((button) => button.textContent === 'Approve')?.click()
      await flush()
    })

    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith({ kind: 'refresh', conversationId: 'conversation-a', reason: 'invalid_option' })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('option is no longer valid')
    await act(async () => root.unmount())
  })
})
