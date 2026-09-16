// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api-client'
import { workspaceApi } from '@/lib/api-workspace'
import { useWorkspaceOnboarding, type WorkspaceOnboardingState } from '@/lib/onboarding'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/api-workspace', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-workspace')>('@/lib/api-workspace')
  return { ...actual, workspaceApi: { ...actual.workspaceApi, getSummary: vi.fn() } }
})

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
  })
}

const mountOnboarding = (workspaceCount: number) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const states: WorkspaceOnboardingState[] = []

  const Probe = () => {
    const state = useWorkspaceOnboarding('workspace-1', workspaceCount)
    useEffect(() => { states.push(state) }, [state])
    return null
  }

  return {
    states,
    latest: () => states.at(-1),
    render: async () => {
      await act(async () => { root.render(<Probe />) })
    },
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

// A rejected summary request must not escape `refresh()`: Vitest fails the run on
// any unhandled rejection, which is exactly the production symptom under test.
describe('useWorkspaceOnboarding refresh', () => {
  afterEach(() => {
    vi.mocked(workspaceApi.getSummary).mockReset()
    window.localStorage.clear()
  })

  it('keeps the default state and settles loading when the summary request is rejected', async () => {
    vi.mocked(workspaceApi.getSummary).mockRejectedValue(
      new ApiError({ status: 404, error: { code: 'not_found', message: 'Workspace not found' } }),
    )
    const mounted = mountOnboarding(1)

    await mounted.render()
    await flush()
    await flush()

    expect(mounted.latest()?.isLoading).toBe(false)
    expect(mounted.latest()?.shouldShowFirstRun).toBe(false)
    expect(mounted.latest()?.hasDocuments).toBe(false)

    await mounted.unmount()
  })
})
