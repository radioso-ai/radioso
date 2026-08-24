/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { useCoalescedAsync } from '@/lib/use-coalesced-async'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useCoalescedAsync', () => {
  it('runs one request at a time and retains only the newest queued call', async () => {
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const operation = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined)
    let refresh!: (value: number) => Promise<void>
    function Probe() {
      refresh = useCoalescedAsync(operation)
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(<Probe />))

    const running = refresh(1)
    void refresh(2)
    void refresh(3)
    expect(operation).toHaveBeenCalledTimes(1)

    releaseFirst()
    await act(async () => running)

    expect(operation).toHaveBeenCalledTimes(2)
    expect(operation).toHaveBeenLastCalledWith(3)
    act(() => root.unmount())
  })
})
