/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  discoverTools: vi.fn(),
}))

vi.mock('@/components/dashboard/settings/assistant-source-scope-selector', () => ({
  AssistantSourceScopeSelector: () => <div data-testid="source-scope-selector" />,
}))

vi.mock('@/lib/api-external-skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-external-skills')>()
  return {
    ...actual,
    externalSkillsApi: {
      ...actual.externalSkillsApi,
      discoverTools: apiMocks.discoverTools,
    },
  }
})

import { SkillForm } from '@/components/dashboard/settings/skills/SkillForm'
import type { AgentSkill, SkillCapabilityDescriptor } from '@/lib/api-skills'

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

const mcpCapability = (): SkillCapabilityDescriptor => ({
  id: 'mcp_tool',
  storedKind: 'external_mcp',
  targetKind: 'mcp_connection',
  requiresTarget: true,
  inputSchema: { source: 'discovered' },
  settingsFields: [],
  outcomeVocabulary: ['completed', 'failed'],
  supportedInvocationModes: ['routine_named'],
  defaultInvocationMode: 'routine_named',
  executorAdapter: 'external_mcp',
  targets: [{ id: 'connection-1', label: 'Support MCP', status: 'authorized' }],
  available: true,
  unavailableReason: null,
})

const mcpSkill = (): AgentSkill => ({
  id: 'skill-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'post_message',
  capability: 'mcp_tool',
  storedKind: 'external_mcp',
  target: { kind: 'mcp_connection', id: 'connection-1' },
  config: {
    toolName: 'post_message',
    boundParams: { urgent: true },
    exposedParams: { message: { description: 'Custom prompt', slotBinding: 'message_text' } },
    declaredOutcomes: ['completed'],
  },
  invocationMode: 'routine_named',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const submitForm = async (label = 'Create skill') => {
  const submitButton = [...document.body.querySelectorAll('button')]
    .find((button) => button.textContent?.includes(label))
  expect(submitButton).toBeTruthy()

  await act(async () => {
    submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('SkillForm submit', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    apiMocks.discoverTools.mockReset()
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
          agentId="agent-1"
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
          agentId="agent-1"
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
          agentId="agent-1"
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
          agentId="agent-1"
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
          agentId="agent-1"
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
          agentId="agent-1"
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

  it('discovers MCP tools and submits required parameters from the selected tool schema', async () => {
    apiMocks.discoverTools.mockResolvedValue({
      tools: [{
        name: 'post_message',
        description: 'Post a support message.',
        inputSchema: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string', description: 'Message text' },
            urgent: { type: 'boolean' },
          },
        },
      }],
    })
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <SkillForm
          agentId="agent-1"
          open
          capabilities={[mcpCapability()]}
          skills={[]}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
        />,
      )
    })

    expect(apiMocks.discoverTools).toHaveBeenCalledWith('agent-1', 'connection-1')
    expect(document.body.textContent).toContain('post_message')

    const routineButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Routine integration'))
    await act(async () => {
      routineButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.textContent).toContain('message')
    expect(document.body.textContent).toContain('Required')

    await submitForm()

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'mcp_connection', id: 'connection-1' },
      config: {
        toolName: 'post_message',
        boundParams: {},
        exposedParams: {
          message: { description: 'Message text', slotBinding: 'message', required: true },
        },
        declaredOutcomes: ['completed', 'failed'],
      },
    }))
  })

  it('hydrates existing MCP parameter bindings from the discovered schema when editing', async () => {
    apiMocks.discoverTools.mockResolvedValue({
      tools: [{
        name: 'post_message',
        inputSchema: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string', description: 'Message text' },
            urgent: { type: 'boolean' },
          },
        },
      }],
    })
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <SkillForm
          agentId="agent-1"
          open
          capabilities={[mcpCapability()]}
          skills={[mcpSkill()]}
          editingSkill={mcpSkill()}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
        />,
      )
    })

    const saveButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save skill'))
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      config: {
        toolName: 'post_message',
        boundParams: { urgent: true },
        exposedParams: {
          message: { description: 'Custom prompt', slotBinding: 'message_text', required: true },
        },
        declaredOutcomes: ['completed'],
      },
    }))
  })

  it('blocks MCP skill submission when tool discovery fails', async () => {
    apiMocks.discoverTools.mockRejectedValue(new Error('MCP server unavailable'))
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <SkillForm
          agentId="agent-1"
          open
          capabilities={[mcpCapability()]}
          skills={[]}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
        />,
      )
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('MCP server unavailable')
    const submitButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Create skill'))
    expect(submitButton?.disabled).toBe(true)

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('preserves existing MCP bindings when discovery fails during editing', async () => {
    apiMocks.discoverTools.mockRejectedValue(new Error('MCP server unavailable'))
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <SkillForm
          agentId="agent-1"
          open
          capabilities={[mcpCapability()]}
          skills={[mcpSkill()]}
          editingSkill={mcpSkill()}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
        />,
      )
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('MCP server unavailable')
    const saveButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Save skill'))
    expect(saveButton?.disabled).toBe(false)

    await submitForm('Save skill')

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      config: {
        toolName: 'post_message',
        boundParams: { urgent: true },
        exposedParams: {
          message: { description: 'Custom prompt', slotBinding: 'message_text' },
        },
        declaredOutcomes: ['completed'],
      },
    }))
  })

  it('reports an empty MCP connection before checking for a missing configured tool', async () => {
    apiMocks.discoverTools.mockResolvedValue({ tools: [] })

    await act(async () => {
      root.render(
        <SkillForm
          agentId="agent-1"
          open
          capabilities={[mcpCapability()]}
          skills={[mcpSkill()]}
          editingSkill={mcpSkill()}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={vi.fn()}
        />,
      )
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toContain('This connection did not publish any MCP tools.')
  })

  it('blocks an edit when the configured MCP tool disappears after refresh', async () => {
    apiMocks.discoverTools
      .mockResolvedValueOnce({
        tools: [{
          name: 'post_message',
          inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
        }],
      })
      .mockResolvedValueOnce({
        tools: [{
          name: 'create_ticket',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        }],
      })

    await act(async () => {
      root.render(
        <SkillForm
          agentId="agent-1"
          open
          capabilities={[mcpCapability()]}
          skills={[mcpSkill()]}
          editingSkill={mcpSkill()}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={vi.fn()}
        />,
      )
    })

    const refreshButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Refresh tools'))
    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toContain('The configured tool “post_message” is no longer published')
    const saveButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Save skill'))
    expect(saveButton?.disabled).toBe(true)
  })

  it('preserves unsaved MCP input drafts when tools are refreshed', async () => {
    apiMocks.discoverTools.mockResolvedValue({
      tools: [{
        name: 'post_message',
        inputSchema: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string', description: 'Message text' },
            urgent: { type: 'boolean' },
          },
        },
      }],
    })
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <SkillForm
          agentId="agent-1"
          open
          capabilities={[mcpCapability()]}
          skills={[mcpSkill()]}
          editingSkill={mcpSkill()}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
        />,
      )
    })

    const routineButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Routine integration'))
    await act(async () => {
      routineButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const urgentInput = document.body.querySelector<HTMLInputElement>('input[placeholder="urgent"]')
    expect(urgentInput?.value).toBe('true')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(urgentInput, 'false')
      urgentInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const refreshButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Refresh tools'))
    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.querySelector<HTMLInputElement>('input[placeholder="urgent"]')?.value).toBe('false')
    await submitForm('Save skill')
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ boundParams: { urgent: false } }),
    }))
  })

  it('shows a loading hint for discovered inputs while the MCP schema is pending', async () => {
    apiMocks.discoverTools.mockReturnValue(new Promise(() => undefined))

    await act(async () => {
      root.render(
        <SkillForm
          agentId="agent-1"
          open
          capabilities={[mcpCapability()]}
          skills={[]}
          isSaving={false}
          error={null}
          onOpenChange={() => undefined}
          onSubmit={vi.fn()}
        />,
      )
    })

    const routineButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Routine integration'))
    await act(async () => {
      routineButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.textContent).toContain('Loading tool schema…')
  })
})
