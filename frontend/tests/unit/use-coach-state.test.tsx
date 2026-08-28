/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildCoachReplayOverride,
  useCoachState,
  type CoachStateDeps,
} from '@/components/dashboard/workbench/use-coach-state'
import type { AgentSettings, Directive, DirectiveDraftResponse } from '@/lib/api'
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
} as unknown as WorkbenchSeedTurn

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

const existingDirective: Directive = {
  id: 'directive-existing',
  agentId: 'agent-1',
  name: 'Saved tone',
  condition: { kind: 'contextual', description: 'When discussing roadmap timing' },
  action: 'Set expectations with dates.',
  priority: 40,
  requiredCapabilities: ['retrieval.answer'],
  dependsOn: ['represent-organization'],
  excludes: ['too-casual'],
  surfaces: [],
  routes: ['retrieval'],
  tags: ['saved'],
  description: 'Existing saved behavior.',
  metadata: { owner: 'ops' },
  binding: null,
  lifecycle: null,
  createdAt: '2026-06-01T09:00:00.000Z',
  updatedAt: '2026-06-01T09:00:00.000Z',
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
  existingDirectives?: Directive[]
  directivesStatus?: 'loading' | 'ready' | 'error'
}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let latest: HookResult | null = null
  let currentSeed = input.seed === undefined ? seedTurn : input.seed

  function Harness() {
    latest = useCoachState({
      selectedAgent: agent,
      seedTurn: currentSeed,
      existingDirectives: input.existingDirectives,
      directivesStatus: input.directivesStatus ?? 'ready',
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
    setSeed(seed: WorkbenchSeedTurn | null) {
      currentSeed = seed
      act(() => {
        root.render(<Harness />)
      })
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
        priority: null,
        requiredCapabilities: [],
        dependsOn: [],
        excludes: [],
        surfaces: [],
        routes: [],
        tags: ['step:onboarding:answer'],
        description: null,
        metadata: {},
      }],
    })
  })

  it('replays existing directives before the draft directive', () => {
    expect(buildCoachReplayOverride(draft.directive, [existingDirective])).toEqual({
      authoredDirectives: [
        {
          name: 'Saved tone',
          condition: { kind: 'contextual', description: 'When discussing roadmap timing' },
          action: 'Set expectations with dates.',
          priority: 40,
          requiredCapabilities: ['retrieval.answer'],
          dependsOn: ['represent-organization'],
          excludes: ['too-casual'],
          surfaces: [],
          routes: ['retrieval'],
          tags: ['saved'],
          description: 'Existing saved behavior.',
          metadata: { owner: 'ops' },
        },
        {
          name: 'Use release note specifics',
          condition: { kind: 'always' },
          action: 'Answer with concrete release note details.',
          priority: null,
          requiredCapabilities: [],
          dependsOn: [],
          excludes: [],
          surfaces: [],
          routes: [],
          tags: ['step:onboarding:answer'],
          description: null,
          metadata: {},
        },
      ],
    })
  })

  it('drafts, captures a snapshot, previews replay, and validates with tags', async () => {
    const deps = createDeps()
    const hook = renderCoachHook({ deps, existingDirectives: [existingDirective] })
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
      agentConfigOverride: buildCoachReplayOverride(draft.directive, [existingDirective]),
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
      surfaces: [],
      metadata: {
        diagnosis: 'directive_recommended',
        rationale: 'The coaching is behavioral.',
      },
    })
    expect(hook.current.status).toBe('done')
  })

  it('saves a drafted directive with the scope it previewed', async () => {
    const deps = createDeps()
    deps.draftDirective = vi.fn().mockResolvedValue({
      ...draft,
      directive: { ...draft.directive, surfaces: ['suggested_questions'] },
    })
    const hook = renderCoachHook({ deps })
    roots.push(hook)

    await act(async () => {
      await hook.current.submitCoaching('Do not invite price questions.')
    })
    await act(async () => {
      await hook.current.validate()
    })

    expect(deps.createDirective).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ surfaces: ['suggested_questions'] }),
    )
  })

  it('blocks coaching while existing directives are loading', async () => {
    const deps = createDeps()
    const hook = renderCoachHook({ deps, directivesStatus: 'loading' })
    roots.push(hook)

    expect(hook.current.canSubmit).toBe(false)

    await act(async () => {
      await hook.current.submitCoaching('Answer with release note specifics.')
    })

    expect(hook.current.status).toBe('error')
    expect(hook.current.error).toBe('Wait for existing directives to load before drafting coaching.')
    expect(deps.draftDirective).not.toHaveBeenCalled()
    expect(deps.replay).not.toHaveBeenCalled()
  })

  it('blocks coaching when existing directives failed to load', async () => {
    const deps = createDeps()
    const hook = renderCoachHook({ deps, directivesStatus: 'error' })
    roots.push(hook)

    expect(hook.current.canSubmit).toBe(false)

    await act(async () => {
      await hook.current.submitCoaching('Answer with release note specifics.')
    })

    expect(hook.current.status).toBe('error')
    expect(hook.current.error).toBe("Couldn't load existing directives. Reload before coaching so the preview matches what gets saved.")
    expect(deps.draftDirective).not.toHaveBeenCalled()
    expect(deps.replay).not.toHaveBeenCalled()
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

  it('captures a new snapshot after the seeded turn identity changes', async () => {
    const nextSeedTurn = {
      conversation: {
        id: 'conversation-2',
        conversationId: 'conversation-2',
        messages: [
          { id: 'user-2', role: 'user', content: 'What is next?', createdAt: '2026-06-01T11:00:00.000Z' },
          { id: 'assistant-2', role: 'assistant', content: 'The next step is unclear.', createdAt: '2026-06-01T11:00:01.000Z' },
        ],
      },
      userTurn: { id: 'user-2', role: 'user', content: 'What is next?', createdAt: '2026-06-01T11:00:00.000Z' },
      assistantTurn: { id: 'assistant-2', role: 'assistant', content: 'The next step is unclear.', createdAt: '2026-06-01T11:00:01.000Z' },
    } as unknown as WorkbenchSeedTurn
    const deps = createDeps({
      captureSnapshot: vi.fn()
        .mockResolvedValueOnce({ id: 'snapshot-1' })
        .mockResolvedValueOnce({ id: 'snapshot-2' }),
    })
    const hook = renderCoachHook({ deps })
    roots.push(hook)

    await act(async () => {
      await hook.current.submitCoaching('Answer with release note specifics.')
    })

    hook.setSeed(nextSeedTurn)

    await act(async () => {
      await hook.current.submitCoaching('Answer with the next concrete step.')
    })

    expect(deps.captureSnapshot).toHaveBeenCalledTimes(2)
    expect(deps.captureSnapshot).toHaveBeenNthCalledWith(2, {
      conversationId: 'conversation-2',
      messageId: 'assistant-2',
    })
    expect(deps.replay).toHaveBeenLastCalledWith({
      snapshotId: 'snapshot-2',
      agentConfigOverride: buildCoachReplayOverride(draft.directive),
    })
  })
})
