/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/dashboard/settings/assistant-source-scope-selector', () => ({
  AssistantSourceScopeSelector: () => <div data-testid="source-scope-selector" />,
}))

import { SkillForm } from '@/components/dashboard/settings/skills/SkillForm'
import type { SkillCapabilityDescriptor } from '@/lib/api-skills'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const capability = (): SkillCapabilityDescriptor => ({
  id: 'email',
  storedKind: 'customer_email',
  targetKind: 'customer_email_connection',
  requiresTarget: true,
  inputSchema: { source: 'static', schema: { fields: ['to'], required: ['to'] } },
  settingsFields: [],
  outcomeVocabulary: ['sent'],
  supportedInvocationModes: ['routine_named'],
  defaultInvocationMode: 'routine_named',
  executorAdapter: 'customer_email',
  targets: [{ id: 'target-1', label: 'Support outbound', status: 'authorized' }],
  available: true,
  unavailableReason: null,
})

describe('SkillForm submit', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('surfaces invalid additional settings JSON without calling onSubmit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <SkillForm
          open
          capabilities={[capability()]}
          skills={[]}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
        />,
      )
    })

    const advancedButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Advanced'))
    expect(advancedButton).toBeTruthy()

    await act(async () => {
      advancedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const extraConfig = document.body.querySelector<HTMLTextAreaElement>('#skill-extra-config')
    expect(extraConfig).toBeTruthy()

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setValue?.call(extraConfig, '[]')
      extraConfig!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const submitButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Create skill'))
    expect(submitButton).toBeTruthy()

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Additional settings must be a JSON object.')
  })
})
