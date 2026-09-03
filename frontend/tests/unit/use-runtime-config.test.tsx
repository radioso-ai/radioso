/* @vitest-environment jsdom */

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useRuntimeConfig, type ResolvedRuntimeConfig } from '@/hooks/use-runtime-config'

let runtimeConfig: ResolvedRuntimeConfig

// Published from an effect, not assigned during render: render must stay free of side effects.
function RuntimeConfigHarness({ onConfig }: { onConfig: (config: ResolvedRuntimeConfig) => void }) {
  const config = useRuntimeConfig()
  useEffect(() => {
    onConfig(config)
  }, [config, onConfig])
  return null
}

const publishConfig = (config: ResolvedRuntimeConfig) => {
  runtimeConfig = config
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('useRuntimeConfig', () => {
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
    vi.unstubAllGlobals()
  })

  it('keeps runtime endpoint failures distinct and retries them', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ mcpUrl: 'https://mcp.example.com/mcp', publicApiUrl: 'https://api.example.com' }),
      })
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => {
      root.render(<RuntimeConfigHarness onConfig={publishConfig} />)
    })
    expect(runtimeConfig).toMatchObject({ mcpUrl: '', publicApiUrl: '', isResolved: false, status: 'failed' })

    await act(async () => {
      runtimeConfig.retry()
    })

    expect(runtimeConfig).toMatchObject({
      mcpUrl: 'https://mcp.example.com/mcp',
      publicApiUrl: 'https://api.example.com',
      isResolved: true,
      status: 'resolved',
    })
  })
})
