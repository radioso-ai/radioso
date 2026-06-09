/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildCoachReplayOverride,
  useCoachState,
  type CoachStateDeps,
} from '@/components/dashboard/workbench/use-coach-state'
import type { AgentSettings, DirectiveDraftResponse } from '@/lib/api'
import type { WorkbenchSeedTurn } from '@/components/dashboard/workbench/use-workbench-state'

const agent = {
  id: 'agent-1',
  name: 'Marta',
} as AgentSettings

const seedTurn = {
  conversation: {
    id: 'conversation-1',
    conversationId: 'conversation-1',
    messages: [
      { id: 'user-1', role: 'user', content: 'What changed?', createdAt: '2026-06-01T10:00:00.000Z' },
      { id: 'assistant-1', role: 'assistant', content: 'Some things changed.', createdAt: '2026-06-01T10:00:01.000Z' },
    ],
  },
  userTurn: { id: 'user-1', role: 'user', content: 'What changed?', createdAt: '2026-06-01T10:00:00.000Z' },
  assistantTurn: { id: 'assistant-1', role: 'assistant', content: 'Some things changed.', createdAt: '2026-06-01T10:00:01.000Z' },
} as WorkbenchSeedTurn

const draft: DirectiveDraftResponse = {
  directive: {
    name: 'Use release note specifics',
    condition: { kind: 'always' },
    action: 'Answer with concrete release note details.',
    tags: ['step:onboarding:answer'],
  },
  diagnosis: 'directive_recommended',
  rationale: 'The coaching is behavioral.',
}

const replayResponse = {
  run: {
    id: 'run-1',
    observedOutput: { retrievedChunks: [], answer: 'Next answer.' },
    overrides: {},
    resolvedConfig: {},
    status: 'recorded',
    startedAt: '2026-06-01T10:00:02.000Z',
    completedAt: '2026-06-01T10:00:03.000Z',
  },
  case: null,
  answer: 'Next answer.',
}

type HookResult = ReturnType<typeof useCoachState>

function renderCoachHook(input: {
  deps: CoachStateDeps
  seed?: WorkbenchSeedTurn | null
}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let latest: HookResult | null = null

  function Harness() {
    latest = useCoachState({
      selectedAgent: agent,
      seedTurn: input.seed === undefined ? seedTurn : input.seed,
      deps: input.deps,
    })
    return null
  }

  act(() => {
    root.render(<Harness />)
  })

  return {
    get current() {
      if (!latest) throw new Error('Hook did not render')
      return latest
    },
    cleanup() {
      act(() => root.unmount())
      container.remove()
    },
  }
}

const createDeps = (overrides: Partial<CoachStateDeps> = {}): CoachStateDeps => ({
  draftDirective: vi.fn().mockResolvedValue(draft),
  createDirective: vi.fn().mockResolvedValue({ directive: { id: 'directive-1', ...draft.directive } }),
  replay: vi.fn().mockResolvedValue(replayResponse),
  captureSnapshot: vi.fn().mockResolvedValue({ id: 'snapshot-1' }),
  ...overrides,
})

describe('coach state', () => {
  let roots: Array<{ cleanup: () => void }> = []

  afterEach(() => {
    roots.forEach((root) => root.cleanup())
    roots = []
    vi.restoreAllMocks()
  })

  it('maps a drafted directive into an authoredDirectives replay override', () => {
    expect(buildCoachReplayOverride(draft.directive)).toEqual({
      authoredDirectives: [{
        name: 'Use release note specifics',
        condition: { kind: 'always' },
        action: 'Answer with concrete release note details.',
        tags: ['step:onboarding:answer'],
      }],
    })
  })

  it('drafts, captures a snapshot, previews replay, and validates with tags', async () => {
    const deps = createDeps()
    const hook = renderCoachHook({ deps })
    roots.push(hook)

    expect(hook.current.status).toBe('idle')

    await act(async () => {
      await hook.current.submitCoaching('Answer with release note specifics.')
    })

    expect(deps.draftDirective).toHaveBeenCalledWith('agent-1', {
      coachingText: 'Answer with release note specifics.',
      turn: {
        userMessage: 'What changed?',
        assistantAnswer: 'Some things changed.',
      },
    })
    expect(deps.captureSnapshot).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      messageId: 'assistant-1',
    })
    expect(deps.replay).toHaveBeenCalledWith({
      snapshotId: 'snapshot-1',
      agentConfigOverride: buildCoachReplayOverride(draft.directive),
    })
    expect(hook.current.status).toBe('preview')
    expect(hook.current.preview?.replay.answer).toBe('Next answer.')

    await act(async () => {
      await hook.current.validate()
    })

    expect(deps.createDirective).toHaveBeenCalledWith('agent-1', {
      name: 'Use release note specifics',
      condition: { kind: 'always' },
      action: 'Answer with concrete release note details.',
      tags: ['step:onboarding:answer'],
      metadata: {
        diagnosis: 'directive_recommended',
        rationale: 'The coaching is behavioral.',
      },
    })
    expect(hook.current.status).toBe('done')
  })

  it('enters error state when draft fails', async () => {
    const deps = createDeps({
      draftDirective: vi.fn().mockRejectedValue(new Error('Draft failed')),
    })
    const hook = renderCoachHook({ deps })
    roots.push(hook)

    await act(async () => {
      await hook.current.submitCoaching('Be clearer.')
    })

    expect(hook.current.status).toBe('error')
    expect(hook.current.error).toBe('Draft failed')
    expect(deps.replay).not.toHaveBeenCalled()
  })
})
