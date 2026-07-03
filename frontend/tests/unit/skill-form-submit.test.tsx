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

const retrievalCapability = (): SkillCapabilityDescriptor => ({
  id: 'retrieve',
  storedKind: 'retrieve',
  targetKind: 'source_scope',
  requiresTarget: false,
  inputSchema: { source: 'static', schema: { fields: [] } },
  settingsFields: [
    {
      key: 'rerankEnabled',
      label: 'Rerank results',
      type: 'boolean',
      help: 'Re-score retrieved chunks.',
      defaultValue: true,
      group: 'Retrieval tuning',
    },
    {
      key: 'semanticRewriteInstructions',
      label: 'Semantic rewrite instructions',
      type: 'textarea',
      help: 'Instructions used for the semantic rewrite.',
      defaultValue: 'Rewrite with the same meaning.',
      group: 'Query rewrite',
    },
  ],
  outcomeVocabulary: ['found'],
  supportedInvocationModes: ['default_answer'],
  defaultInvocationMode: 'default_answer',
  executorAdapter: 'retrieval.answer',
  targets: [],
  available: true,
  unavailableReason: null,
})

const submitForm = async () => {
  const submitButton = [...document.body.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Create skill'))
  expect(submitButton).toBeTruthy()

  await act(async () => {
    submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

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

    const routineButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Routine integration'))
    expect(routineButton).toBeTruthy()

    await act(async () => {
      routineButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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

  it('submits no key for an unset boolean default', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <SkillForm
          open
          capabilities={[retrievalCapability()]}
          skills={[]}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
        />,
      )
    })

    await submitForm()

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]?.[0].config).not.toHaveProperty('rerankEnabled')
  })

  it('submits an explicit value after toggling an unset boolean', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <SkillForm
          open
          capabilities={[retrievalCapability()]}
          skills={[]}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
        />,
      )
    })

    const rerankSwitch = document.body.querySelector<HTMLElement>('#skill-setting-rerankEnabled')
    expect(rerankSwitch).toBeTruthy()

    await act(async () => {
      rerankSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await submitForm()

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]?.[0].config).toMatchObject({ rerankEnabled: false })
  })

  it('clears a boolean override when reset to default is clicked', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <SkillForm
          open
          capabilities={[retrievalCapability()]}
          skills={[]}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
        />,
      )
    })

    const rerankSwitch = document.body.querySelector<HTMLElement>('#skill-setting-rerankEnabled')
    expect(rerankSwitch).toBeTruthy()

    await act(async () => {
      rerankSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const resetButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Reset to default'))
    expect(resetButton).toBeTruthy()

    await act(async () => {
      resetButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await submitForm()

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]?.[0].config).not.toHaveProperty('rerankEnabled')
  })

  it('keeps a defaulted textarea read-only until overridden and submits the edited override', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <SkillForm
          open
          capabilities={[retrievalCapability()]}
          skills={[]}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
        />,
      )
    })

    const textarea = document.body.querySelector<HTMLTextAreaElement>('#skill-setting-semanticRewriteInstructions')
    expect(textarea).toBeTruthy()
    expect(textarea?.disabled).toBe(true)
    expect(textarea?.value).toBe('Rewrite with the same meaning.')

    const overrideButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent === 'Override')
    expect(overrideButton).toBeTruthy()

    await act(async () => {
      overrideButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const editable = document.body.querySelector<HTMLTextAreaElement>('#skill-setting-semanticRewriteInstructions')
    expect(editable?.disabled).toBe(false)
    expect(editable?.value).toBe('Rewrite with the same meaning.')

    const setTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setTextareaValue?.call(editable, 'Rewrite with the same meaning. Prefer event names.')
      editable?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await submitForm()

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]?.[0].config).toMatchObject({
      semanticRewriteInstructions: 'Rewrite with the same meaning. Prefer event names.',
    })
  })

  it('omits a defaulted textarea from the config when it is not overridden', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <SkillForm
          open
          capabilities={[retrievalCapability()]}
          skills={[]}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
        />,
      )
    })

    await submitForm()

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]?.[0].config).not.toHaveProperty('semanticRewriteInstructions')
  })
})
