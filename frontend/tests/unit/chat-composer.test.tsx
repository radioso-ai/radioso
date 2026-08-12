/* @vitest-environment jsdom */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatComposer } from '@/components/chat/chat-composer'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

function ComposerHarness({ maxLength }: { maxLength?: number }) {
  const [value, setValue] = useState('')
  return <ChatComposer value={value} onChange={setValue} onSubmit={() => {}} ariaLabel="Ask Ray" maxLength={maxLength} />
}

const setTextareaValue = (textarea: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ChatComposer', () => {
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

  it('enables Send only for non-whitespace input', () => {
    act(() => root.render(<ComposerHarness />))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const send = container.querySelector('button[aria-label="Send question"]') as HTMLButtonElement

    expect(send.disabled).toBe(true)
    act(() => {
      setTextareaValue(textarea, '   ')
    })
    expect(send.disabled).toBe(true)
    act(() => {
      setTextareaValue(textarea, 'Tell me more')
    })
    expect(send.disabled).toBe(false)
  })

  it('shows the optional character counter only when a maximum is set', () => {
    act(() => root.render(<ComposerHarness maxLength={12} />))
    expect(container.textContent).toContain('0/12')

    act(() => root.render(<ComposerHarness />))
    expect(container.textContent).not.toContain('0/12')
  })

  it('submits on Enter but preserves Shift+Enter for a newline', () => {
    const onSubmit = vi.fn()
    act(() => root.render(<ChatComposer value="A question" onChange={() => {}} onSubmit={onSubmit} ariaLabel="Ask Ray" />))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
