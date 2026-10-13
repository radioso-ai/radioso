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
  return {
    ...actual,
    workspaceApi: {
      ...actual.workspaceApi,
      getSummary: vi.fn(),
      updateSetupState: vi.fn(),
    },
  }
})

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
  })
}

const mountOnboarding = () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const states: WorkspaceOnboardingState[] = []

  const Probe = () => {
    const state = useWorkspaceOnboarding('workspace-1')
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
    vi.mocked(workspaceApi.updateSetupState).mockReset()
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('keeps the default state and settles loading when the summary request is rejected', async () => {
    vi.mocked(workspaceApi.getSummary).mockRejectedValue(
      new ApiError({ status: 404, error: { code: 'not_found', message: 'Workspace not found' } }),
    )
    const mounted = mountOnboarding()

    await mounted.render()
    await flush()
    await flush()

    expect(mounted.latest()?.isLoading).toBe(false)
    expect(mounted.latest()?.shouldShowFirstRun).toBe(false)
    expect(mounted.latest()?.hasDocuments).toBe(false)

    await mounted.unmount()
  })

  it('treats a summary from an older backend without setup state as no server decision', async () => {
    vi.mocked(workspaceApi.getSummary).mockResolvedValue({
      documentCount: 0,
      readyDocumentCount: 0,
      pendingDocumentCount: 0,
      sampleDocumentCount: 0,
      sampleDocumentSlugs: [],
      conversationCount: 0,
      hasDocuments: false,
      hasPendingDocuments: false,
      hasReadyDocuments: false,
      hasCompletedChat: false,
      sampleDocumentsImported: false,
      websiteCrawlerEnabled: true,
    })
    const mounted = mountOnboarding()

    await mounted.render()
    await flush()
    await flush()

    expect(mounted.latest()?.shouldShowFirstRun).toBe(false)
    expect(mounted.latest()?.isOnboardingActive).toBe(false)
    await mounted.unmount()
  })

  it('keeps first run active after a failed dismissal and allows a successful retry', async () => {
    vi.mocked(workspaceApi.getSummary).mockResolvedValue({
      documentCount: 0,
      readyDocumentCount: 0,
      pendingDocumentCount: 0,
      sampleDocumentCount: 0,
      sampleDocumentSlugs: [],
      conversationCount: 0,
      hasDocuments: false,
      hasPendingDocuments: false,
      hasReadyDocuments: false,
      hasCompletedChat: false,
      sampleDocumentsImported: false,
      websiteCrawlerEnabled: true,
      setup: {
        purpose: null,
        dismissed: false,
        skippedSteps: [],
        shouldShowFirstRun: true,
        hasDirectivesOrRoutines: false,
        hasNotifyDestination: false,
        hasNotifyDeliveryConfirmed: false,
        hasCredential: false,
      },
    })
    vi.mocked(workspaceApi.updateSetupState)
      .mockRejectedValueOnce(new ApiError({ status: 404, error: { code: 'not_found', message: 'Route not found' } }))
      .mockResolvedValueOnce({
        purpose: null,
        dismissed: true,
        skippedSteps: [],
        shouldShowFirstRun: false,
        hasDirectivesOrRoutines: false,
        hasNotifyDestination: false,
        hasNotifyDeliveryConfirmed: false,
        hasCredential: false,
      })
    const mounted = mountOnboarding()
    await mounted.render()
    await flush()
    await flush()

    let persisted = true
    await act(async () => { persisted = await mounted.latest()!.markCompleted() })
    expect(persisted).toBe(false)
    expect(mounted.latest()?.shouldShowFirstRun).toBe(true)

    await act(async () => { persisted = await mounted.latest()!.markCompleted() })
    expect(persisted).toBe(true)
    expect(mounted.latest()?.shouldShowFirstRun).toBe(false)
    await mounted.unmount()
  })

  it('emits each observed first-run step once per workspace, including a completed chat', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetch)
    vi.mocked(workspaceApi.getSummary).mockResolvedValue({
      documentCount: 1,
      readyDocumentCount: 1,
      pendingDocumentCount: 0,
      sampleDocumentCount: 1,
      sampleDocumentSlugs: ['getting-started'],
      conversationCount: 1,
      hasDocuments: true,
      hasPendingDocuments: false,
      hasReadyDocuments: true,
      hasCompletedChat: true,
      sampleDocumentsImported: true,
      websiteCrawlerEnabled: true,
      setup: {
        purpose: null,
        dismissed: false,
        skippedSteps: [],
        shouldShowFirstRun: true,
        hasDirectivesOrRoutines: false,
        hasNotifyDestination: false,
        hasNotifyDeliveryConfirmed: false,
        hasCredential: false,
      },
    })

    const firstMount = mountOnboarding()
    await firstMount.render()
    await flush()
    await flush()
    await firstMount.unmount()

    const secondMount = mountOnboarding()
    await secondMount.render()
    await flush()
    await flush()
    await secondMount.unmount()

    const eventNames = fetch.mock.calls.map(([, options]) => {
      const request = options as RequestInit
      if (typeof request.body !== 'string') {
        throw new Error('Expected analytics request body to be a string')
      }
      return JSON.parse(request.body) as { eventName: string }
    }).map((event) => event.eventName)

    expect(eventNames).toEqual([
      'onboarding.step_completed',
      'onboarding.step_completed',
      'onboarding.sample_imported',
      'onboarding.step_completed',
      'onboarding.first_question',
    ])
  })
})
