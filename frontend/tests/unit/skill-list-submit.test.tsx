/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSkillCreateInput } from '@/lib/api-skills'

const apiMocks = vi.hoisted(() => ({
  getSkillCapabilities: vi.fn(),
  listSkills: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
}))

const usageApiMocks = vi.hoisted(() => ({
  listDirectives: vi.fn(),
  listRoutines: vi.fn(),
}))

vi.mock('@/components/dashboard/shared/skills-header-action', () => ({
  useRegisterAddSkillAction: () => undefined,
}))

vi.mock('@/components/dashboard/settings/skills/SkillForm', () => ({
  SkillForm: ({ open, editingSkill, onSubmit }: {
    open: boolean
    editingSkill?: unknown
    onSubmit: (input: AgentSkillCreateInput) => Promise<void>
  }) => open ? (
    <button
      type="button"
      onClick={() => void onSubmit({
        name: 'answer',
        capability: 'retrieve',
        target: { kind: 'source_scope', id: null },
        config: { sourceScope: 'all', exposedInputs: { query: true } },
        invocationMode: 'default_answer',
        enabled: true,
      })}
    >
      {editingSkill ? 'mock-save-edit' : 'mock-save-create'}
    </button>
  ) : null,
}))

vi.mock('@/lib/api-skills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-skills')>()),
  agentSkillsApi: apiMocks,
}))

vi.mock('@/lib/api-directives', () => ({ directivesApi: usageApiMocks }))
vi.mock('@/lib/api-routines', () => ({ routinesApi: usageApiMocks }))

import { SkillList } from '@/components/dashboard/settings/skills/SkillList'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const retrieveCapability = {
  id: 'retrieve',
  storedKind: 'retrieve',
  targetKind: 'source_scope',
  requiresTarget: false,
  inputSchema: { source: 'static', schema: { fields: [] } },
  settingsFields: [],
  outcomeVocabulary: ['found'],
  supportedInvocationModes: ['default_answer'],
  defaultInvocationMode: 'default_answer',
  executorAdapter: 'retrieval.answer',
  targets: [],
  available: true,
  unavailableReason: null,
} as const

const retrieveSkill = {
  id: 'skill-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'answer',
  capability: 'retrieve',
  storedKind: 'retrieve',
  target: { kind: 'source_scope', id: null },
  config: { sourceScope: 'all', exposedInputs: { query: true }, rerankEnabled: false },
  invocationMode: 'default_answer',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as const

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('SkillList submit', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    apiMocks.getSkillCapabilities.mockResolvedValue({ capabilities: [retrieveCapability] })
    apiMocks.listSkills.mockResolvedValue({ skills: [retrieveSkill] })
    apiMocks.createSkill.mockResolvedValue({ skill: retrieveSkill })
    apiMocks.updateSkill.mockResolvedValue({
      skill: {
        ...retrieveSkill,
        config: { sourceScope: 'all', exposedInputs: { query: true } },
      },
    })
    apiMocks.deleteSkill.mockResolvedValue(undefined)
    usageApiMocks.listDirectives.mockResolvedValue({ directives: [] })
    usageApiMocks.listRoutines.mockResolvedValue({ routines: [] })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.clearAllMocks()
  })

  it('replaces config on edit so omitted defaulted fields clear stored overrides', async () => {
    await act(async () => {
      root.render(<SkillList agentId="agent-1" />)
    })

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Edit answer"]')?.click()
    })
    await act(async () => {
      ;[...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'mock-save-edit')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(apiMocks.updateSkill).toHaveBeenCalledWith('agent-1', 'skill-1', {
      target: { kind: 'source_scope', id: null },
      replaceConfig: { sourceScope: 'all', exposedInputs: { query: true } },
      invocationMode: 'default_answer',
      enabled: true,
    })
  })

  it('discards an older agent load that completes after the active agent load', async () => {
    const firstCapabilities = deferred<{ capabilities: readonly typeof retrieveCapability[] }>()
    const firstSkills = deferred<{ skills: readonly typeof retrieveSkill[] }>()
    const secondSkill = { ...retrieveSkill, id: 'skill-2', agentId: 'agent-2', name: 'second-answer' } as const

    apiMocks.getSkillCapabilities.mockImplementation((agentId: string) =>
      agentId === 'agent-1'
        ? firstCapabilities.promise
        : Promise.resolve({ capabilities: [retrieveCapability] }),
    )
    apiMocks.listSkills.mockImplementation((agentId: string) =>
      agentId === 'agent-1'
        ? firstSkills.promise
        : Promise.resolve({ skills: [secondSkill] }),
    )

    await act(async () => {
      root.render(<SkillList agentId="agent-1" />)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      root.render(<SkillList agentId="agent-2" />)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.textContent).toContain('@second-answer')

    await act(async () => {
      firstCapabilities.resolve({ capabilities: [retrieveCapability] })
      firstSkills.resolve({ skills: [retrieveSkill] })
      await Promise.resolve()
    })

    expect(container.textContent).toContain('@second-answer')
    expect(container.textContent).not.toContain('@answer')
  })
})
