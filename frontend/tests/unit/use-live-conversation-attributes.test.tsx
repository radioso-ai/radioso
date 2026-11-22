/* @vitest-environment jsdom */

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getHistoryConversation: vi.fn() }))
vi.mock('@/lib/api', () => ({ chatApi: api }))

import { useLiveConversationAttributes } from '@/components/dashboard/use-live-conversation-attributes'
import type { ChatConversationMessage, ConversationAttribute } from '@/lib/api-types'

const attribute = (value: string): ConversationAttribute => ({
  name: 'topic',
  valueType: 'enum',
  value,
  option: { label: value, archived: false },
  redacted: false,
  scope: 'conversation',
  writtenBy: { kind: 'classifier', ref: null },
  updatedAt: '2026-11-22T09:30:00.000Z',
  classified: true,
})

const message = (id: string) => ({ id, role: 'user', content: id }) as ChatConversationMessage

interface Props {
  conversationId: string | null
  loaded: ConversationAttribute[] | undefined
  messages: ChatConversationMessage[]
  hasPolled: boolean
}

let shown: ConversationAttribute[] | undefined
let applyChange: (name: string, changed: ConversationAttribute | null) => void = () => undefined
function Probe({ conversationId, loaded, messages, hasPolled }: Props) {
  const live = useLiveConversationAttributes({ conversationId, loaded, tail: { messages, hasPolled } })
  useEffect(() => {
    shown = live.attributes
    applyChange = live.applyChange
  })
  return null
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('useLiveConversationAttributes', () => {
  let container: HTMLDivElement
  let root: Root
  const loaded = [attribute('billing')]
  const render = (props: Partial<Props>) => act(async () => {
    root.render(<Probe conversationId="conversation-1" loaded={loaded} messages={[]} hasPolled={false} {...props} />)
  })
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

  beforeEach(() => {
    vi.useFakeTimers()
    api.getHistoryConversation.mockReset()
    api.getHistoryConversation.mockResolvedValue({ attributes: [attribute('shipping')] })
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
  })

  it('shows the attributes the detail loaded, and reads nothing for the window the first poll repeats', async () => {
    await render({})
    await render({ messages: [message('m1')], hasPolled: true })
    await advance(30_000)

    expect(shown).toBe(loaded)
    expect(api.getHistoryConversation).not.toHaveBeenCalled()
  })

  it('reads them again, a bounded number of times, after the tail delivers a new message', async () => {
    await render({ messages: [message('m1')], hasPolled: true })
    await render({ messages: [message('m1'), message('m2')], hasPolled: true })

    await advance(3_000)
    expect(api.getHistoryConversation).toHaveBeenCalledWith('conversation-1', { limit: 1 })
    expect(shown).toEqual([attribute('shipping')])

    await advance(60_000)
    expect(api.getHistoryConversation).toHaveBeenCalledTimes(2)
  })

  it('shows the detail again once it reloads, rather than an older read', async () => {
    await render({ messages: [message('m1')], hasPolled: true })
    await render({ messages: [message('m1'), message('m2')], hasPolled: true })
    await advance(3_000)

    const reloaded = [attribute('returns')]
    await render({ loaded: reloaded, messages: [message('m1'), message('m2')], hasPolled: true })

    expect(shown).toBe(reloaded)
  })

  it('shows a teammate\'s edit at once, over a read that started before it', async () => {
    let finishRead: (detail: { attributes: ConversationAttribute[] }) => void = () => undefined
    api.getHistoryConversation.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve }))
    await render({ messages: [message('m1')], hasPolled: true })
    await render({ messages: [message('m1'), message('m2')], hasPolled: true })
    await advance(3_000)

    const edited = { ...attribute('shipping'), writtenBy: { kind: 'operator' as const, ref: 'user-1' } }
    await act(async () => applyChange('topic', edited))
    expect(shown).toEqual([edited])

    await act(async () => finishRead({ attributes: [attribute('billing')] }))
    expect(shown).toEqual([edited])

    await act(async () => applyChange('topic', null))
    expect(shown).toEqual([])
  })

  it('drops a read for one conversation once another is open', async () => {
    await render({ messages: [message('m1')], hasPolled: true })
    await render({ messages: [message('m1'), message('m2')], hasPolled: true })
    const other = [attribute('returns')]
    await render({ conversationId: 'conversation-2', loaded: other, messages: [], hasPolled: false })
    await advance(30_000)

    expect(api.getHistoryConversation).not.toHaveBeenCalled()
    expect(shown).toBe(other)
  })
})
