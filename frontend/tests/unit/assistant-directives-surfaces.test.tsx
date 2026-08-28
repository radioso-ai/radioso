/* @vitest-environment jsdom */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AssistantDirectivesSection } from '@/components/dashboard/settings/assistant-directives-section'
import type { BuiltInDirective, Directive } from '@/lib/api'

const apiMocks = vi.hoisted(() => ({
  listDirectives: vi.fn(),
  listSkills: vi.fn(),
  getSkillCapabilities: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  directivesApi: {
    listDirectives: apiMocks.listDirectives,
    createDirective: vi.fn(),
    updateDirective: vi.fn(),
    deleteDirective: vi.fn(),
  },
}))

vi.mock('@/lib/api-skills', () => ({
  agentSkillsApi: {
    listSkills: apiMocks.listSkills,
    getSkillCapabilities: apiMocks.getSkillCapabilities,
    createSkill: vi.fn(),
  },
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('@/components/dashboard/settings/directive-replaces-field', () => ({
  DirectiveReplacesField: ({
    builtIns,
    authored,
    selected,
  }: {
    builtIns: Array<{ name: string }>
    authored: Array<{ name: string }>
    selected: string[]
  }) => (
    <div
      data-testid="replaces-field"
      data-built-ins={builtIns.map((candidate) => candidate.name).join(',')}
      data-authored={authored.map((candidate) => candidate.name).join(',')}
      data-selected={selected.join(',')}
    />
  ),
}))

vi.mock('@/components/dashboard/settings/skill-mention-input', () => ({
  mentionsSkill: (action: string, skillName: string) => action.includes(`#${skillName}`),
  SkillMentionInput: ({
    recognizedSkillNames,
    onSkillsChange,
  }: {
    recognizedSkillNames: string[]
    onSkillsChange: (names: string[]) => void
  }) => recognizedSkillNames.length > 0 ? (
    <button type="button" aria-label="Remove bound skill" onClick={() => onSkillsChange([])}>
      Remove skill
    </button>
  ) : <div />,
}))

vi.mock('@/components/dashboard/settings/skills/CapabilityPicker', () => ({
  CapabilityPicker: () => null,
}))

vi.mock('@/components/dashboard/settings/skills/SkillForm', () => ({
  SkillForm: () => null,
}))

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const now = '2026-08-28T00:00:00.000Z'

const directive = (
  input: Pick<Directive, 'id' | 'name'> & Partial<Directive>,
): Directive => {
  const { id, name, ...overrides } = input
  return {
    id,
    agentId: 'agent-1',
    name,
    condition: { kind: 'always' },
    action: `${name} instruction`,
    priority: null,
    requiredCapabilities: [],
    dependsOn: [],
    excludes: [],
    surfaces: [],
    routes: [],
    tags: [],
    description: null,
    binding: null,
    lifecycle: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const builtIn: BuiltInDirective = {
  name: 'Default reply',
  condition: { kind: 'always' },
  action: 'Write a useful reply.',
  priority: 50,
  description: null,
}

const click = async (element: Element | null) => {
  expect(element).not.toBeNull()
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

describe('assistant directive surface-aware editing', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    apiMocks.listSkills.mockResolvedValue({ skills: [] })
    apiMocks.getSkillCapabilities.mockResolvedValue({ capabilities: [] })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const renderSection = async (directives: Directive[]) => {
    apiMocks.listDirectives.mockResolvedValue({ directives, builtIns: [builtIn] })
    await act(async () => {
      root.render(<AssistantDirectivesSection agentId="agent-1" />)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('does not present a suggestion-only legacy exclusion as replacing a reply built-in', async () => {
    await renderSection([
      directive({
        id: 'suggestion-rule',
        name: 'Suggestion rule',
        surfaces: ['suggested_questions'],
        excludes: ['Default reply'],
      }),
    ])

    expect(container.querySelector('[aria-label="Replace Default reply for this agent"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Replaced by Suggestion rule')
    expect(container.textContent).not.toContain('Replaces: Default reply')

    await click(container.querySelector('[aria-label="Edit Suggestion rule"]'))
    const replacesField = container.querySelector('[data-testid="replaces-field"]')
    expect(replacesField?.getAttribute('data-built-ins')).toBe('')
    expect(replacesField?.getAttribute('data-selected')).toBe('')
  })

  it('removes selected replacements and candidates that no longer overlap after a surface change', async () => {
    await renderSection([
      directive({
        id: 'edited-rule',
        name: 'Edited rule',
        surfaces: ['answer', 'suggested_questions'],
        excludes: ['Default reply'],
      }),
      directive({ id: 'answer-rule', name: 'Answer rule', surfaces: [] }),
      directive({ id: 'suggestion-rule', name: 'Suggestion rule', surfaces: ['suggested_questions'] }),
    ])

    await click(container.querySelector('[aria-label="Edit Edited rule"]'))
    const replySurface = container.querySelector('[aria-label="The agent\'s reply"]')
    await click(replySurface)

    expect(replySurface?.getAttribute('aria-checked')).toBe('false')
    const replacesField = container.querySelector('[data-testid="replaces-field"]')
    expect(replacesField?.getAttribute('data-built-ins')).toBe('')
    expect(replacesField?.getAttribute('data-authored')).toBe('Suggestion rule')
    expect(replacesField?.getAttribute('data-selected')).toBe('')
  })

  it('keeps the reply selected until its bound skill is removed', async () => {
    await renderSection([
      directive({
        id: 'bound-rule',
        name: 'Bound rule',
        action: 'Look it up with #catalog_lookup.',
        surfaces: ['answer', 'suggested_questions'],
        binding: { kind: 'skill', skillName: 'catalog_lookup' },
      }),
    ])

    await click(container.querySelector('[aria-label="Edit Bound rule"]'))
    const replySurface = container.querySelector<HTMLButtonElement>('[aria-label="The agent\'s reply"]')

    expect(replySurface?.disabled).toBe(true)
    expect(container.textContent).toContain('Remove the skill from the instruction before deselecting the reply.')

    await click(container.querySelector('[aria-label="Remove bound skill"]'))
    expect(replySurface?.disabled).toBe(false)
    await click(replySurface)
    expect(replySurface?.getAttribute('aria-checked')).toBe('false')
  })
})
