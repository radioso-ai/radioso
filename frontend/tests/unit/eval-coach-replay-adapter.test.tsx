/* @vitest-environment jsdom */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { EvalView } from '@/components/dashboard/eval-view'
import type { CoachStateDeps } from '@/components/dashboard/workbench/use-coach-state'
import type { DashboardRouteState } from '@/lib/dashboard-routes'

const mocks = vi.hoisted(() => ({
  coachDeps: undefined as Partial<CoachStateDeps> | undefined,
  getCase: vi.fn(),
  getSnapshot: vi.fn(),
  runCase: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({
  agentsApi: { getAgent: vi.fn().mockRejectedValue(new Error('Use captured agent')) },
  directivesApi: { listDirectives: vi.fn().mockResolvedValue({ directives: [] }) },
  documentsApi: { listDocuments: vi.fn().mockResolvedValue({ documents: [] }) },
  evalsApi: {
    getCase: mocks.getCase,
    getSnapshot: mocks.getSnapshot,
    runCase: mocks.runCase,
  },
  routinesApi: { listRoutines: vi.fn().mockResolvedValue({ routines: [] }) },
}))

vi.mock('@/lib/copilot-context', () => ({ useCopilotEntity: vi.fn() }))
vi.mock('@/lib/skill-catalog', () => ({ useSkillCatalog: () => new Map() }))

vi.mock('@/components/dashboard/eval/assertion-editor', () => ({ AssertionEditor: () => null }))
vi.mock('@/components/dashboard/workbench/workbench-override-panel', () => ({ WorkbenchOverridePanel: () => null }))
vi.mock('@/components/dashboard/chat-message-thread', () => ({ ChatMessageThread: () => null }))
vi.mock('@/components/dashboard/workbench/training-view', () => ({
  TrainingView: ({ coachDeps }: { coachDeps?: Partial<CoachStateDeps> }) => {
    mocks.coachDeps = coachDeps
    return null
  },
}))
vi.mock('@/components/dashboard/shared/dashboard-page', () => ({
  DashboardPage: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const now = '2026-08-28T10:00:00.000Z'

describe('eval coaching replay adapter', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mocks.coachDeps = undefined
    mocks.getCase.mockReset().mockResolvedValue({
      id: 'case-1',
      workspaceId: 'workspace-1',
      snapshotId: 'snapshot-1',
      name: 'Suggestion preview',
      assertions: [],
      status: 'pending',
      lastRunId: null,
      createdAt: now,
      updatedAt: now,
      runs: [],
    })
    mocks.getSnapshot.mockReset().mockResolvedValue({
      id: 'snapshot-1',
      workspaceId: 'workspace-1',
      sourceConversationId: 'conversation-1',
      sourceMessageId: 'assistant-1',
      replayTarget: { userMessageId: 'user-1', assistantMessageId: 'assistant-1' },
      fidelity: 'full',
      messages: [
        { id: 'user-1', role: 'user', content: 'What next?', createdAt: now },
        { id: 'assistant-1', role: 'assistant', content: 'Original answer', createdAt: now },
      ],
      originalInstructionBlock: null,
      originalModelId: null,
      originalRetrievalSettings: null,
      originalRetrievalResult: null,
      originalAgent: null,
      originalAgentConfig: { name: 'Captured agent' },
      sourceAgentId: 'agent-1',
      originalRoutineState: null,
      capturedAt: now,
      capturedBy: null,
    })
    mocks.runCase.mockReset().mockResolvedValue({
      run: {
        id: 'run-1',
        observedOutput: {
          retrievedChunks: [],
          answer: 'Preview answer',
          suggestions: [{ text: 'See the roadmap' }],
        },
        resolvedConfig: {},
      },
      case: null,
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('forwards generated suggestions to the training preview', async () => {
    await act(async () => {
      root.render(
        <EvalView
          accountId="account-1"
          routeState={{ evalCaseId: 'case-1' } as DashboardRouteState}
        />,
      )
    })
    await vi.waitFor(() => expect(mocks.coachDeps?.replay).toBeTypeOf('function'))

    const replay = await mocks.coachDeps!.replay!({
      snapshotId: 'snapshot-1',
      agentConfigOverride: {},
    })

    expect(replay.suggestions).toEqual([{ text: 'See the roadmap' }])
  })
})
