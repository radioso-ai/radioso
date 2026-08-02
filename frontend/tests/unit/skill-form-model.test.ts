import { describe, expect, it } from 'vitest'

import {
  buildAgentSkillInput,
  createInitialSkillDraft,
  deriveSkillFields,
  validateSkillName,
} from '@/components/dashboard/settings/skills/skill-form-model'
import type { AgentSkill, SkillCapabilityDescriptor } from '@/lib/api-skills'

const baseCapability = (input: Partial<SkillCapabilityDescriptor> = {}): SkillCapabilityDescriptor => ({
  id: 'email',
  storedKind: 'customer_email',
  targetKind: 'customer_email_connection',
  requiresTarget: true,
  inputSchema: { source: 'static', schema: { fields: ['to', 'subject', 'bodyText'] } },
  settingsFields: [],
  outcomeVocabulary: ['sent', 'failed'],
  supportedInvocationModes: ['routine_named', 'agent_selectable'],
  executorAdapter: 'customer_email',
  targets: [{ id: 'target-1', label: 'Support outbound', status: 'authorized' }],
  available: true,
  unavailableReason: null,
  ...input,
})

const baseSkill = (input: Partial<AgentSkill> = {}): AgentSkill => ({
  id: 'skill-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'send_email',
  capability: 'email',
  storedKind: 'customer_email',
  target: { kind: 'customer_email_connection', id: 'target-1' },
  config: {
    boundInputs: { subject: 'Follow up' },
    exposedInputs: { to: { slotBinding: 'email' }, bodyText: { slotBinding: 'message' } },
  },
  invocationMode: 'routine_named',
  enabled: true,
  createdAt: '2026-06-22T00:00:00.000Z',
  updatedAt: '2026-06-22T00:00:00.000Z',
  ...input,
})

const webhookCapability = (): SkillCapabilityDescriptor => baseCapability({
  id: 'webhook_call',
  storedKind: 'webhook',
  targetKind: 'webhook_destination',
  inputSchema: { source: 'static', schema: { fields: ['payload'], required: ['payload'] } },
  settingsFields: [],
  outcomeVocabulary: ['completed', 'failed'],
  executorAdapter: 'webhook',
  targets: [{ id: 'destination-1', label: 'Calendar webhook', status: 'active' }],
})

const webhookSkill = (config: Record<string, unknown>): AgentSkill => baseSkill({
  name: 'record_calendar_preference',
  capability: 'webhook_call',
  storedKind: 'webhook',
  target: { kind: 'webhook_destination', id: 'destination-1' },
  config,
})

describe('skill form model', () => {
  it('derives static descriptor fields without capability branching', () => {
    expect(deriveSkillFields(baseCapability())).toEqual([
      { name: 'to', type: 'string', description: null, required: true },
      { name: 'subject', type: 'string', description: null, required: true },
      { name: 'bodyText', type: 'string', description: null, required: true },
    ])
  })

  it('hydrates an edit draft from the uniform skill envelope', () => {
    const draft = createInitialSkillDraft([baseCapability()], baseSkill())

    expect(draft).toMatchObject({
      capabilityId: 'email',
      targetId: 'target-1',
      name: 'send_email',
      invocationMode: 'routine_named',
      enabled: true,
      inputDrafts: {
        subject: { mode: 'bind', boundValue: 'Follow up' },
        to: { mode: 'expose', slotBinding: 'email' },
        bodyText: { mode: 'expose', slotBinding: 'message' },
      },
    })
  })

  it('creates a defaulted draft for new skills', () => {
    const capability = baseCapability({
      inputSchema: { source: 'static', schema: { fields: ['to', 'cc', 'subject', 'bodyText'], required: ['to', 'subject', 'bodyText'] } },
      outcomeVocabulary: ['sent', 'failed'],
      defaultInvocationMode: 'agent_selectable',
    })
    const draft = createInitialSkillDraft([capability], null, [
      baseSkill({ id: 'skill-2', name: 'send_support_outbound_email' }),
    ])

    expect(draft).toMatchObject({
      name: 'send_support_outbound_email_2',
      targetId: 'target-1',
      invocationMode: 'agent_selectable',
      enabled: true,
      selectedOutcomes: ['sent', 'failed'],
      inputDrafts: {
        to: { mode: 'expose', slotBinding: 'to' },
        cc: { mode: 'ignore', slotBinding: 'cc' },
        subject: { mode: 'expose', slotBinding: 'subject' },
        bodyText: { mode: 'expose', slotBinding: 'bodyText' },
      },
    })
  })

  it('validates skill names against routine identifier and agent uniqueness rules', () => {
    expect(validateSkillName('', [], null)).toBe('Enter a skill name.')
    expect(validateSkillName('Bad Name', [], null)).toContain('lowercase routine identifier')
    expect(validateSkillName('send_email', [baseSkill()], null)).toBe('@send_email is already used by this agent.')
    expect(validateSkillName('send_email', [baseSkill()], 'skill-1')).toBeNull()
  })

  it('builds a create payload using descriptor target and input schema metadata', () => {
    const capability = baseCapability()
    const draft = createInitialSkillDraft([capability], null)
    draft.name = 'send_email'
    draft.inputDrafts.to = { mode: 'expose', boundValue: '', description: '', slotBinding: 'email' }
    draft.inputDrafts.subject = { mode: 'bind', boundValue: 'Follow up', description: '', slotBinding: 'subject' }
    draft.inputDrafts.bodyText = { mode: 'expose', boundValue: '', description: '', slotBinding: 'message' }
    draft.extraConfigJson = '{"mode":"send"}'

    expect(buildAgentSkillInput(capability, draft, deriveSkillFields(capability))).toEqual({
      name: 'send_email',
      capability: 'email',
      target: { kind: 'customer_email_connection', id: 'target-1' },
      config: {
        mode: 'send',
        boundInputs: { subject: 'Follow up' },
        exposedInputs: {
          to: { slotBinding: 'email', required: true },
          bodyText: { slotBinding: 'message', required: true },
        },
      },
      invocationMode: 'routine_named',
      enabled: true,
    })
  })

  it('hydrates typed descriptor settings from existing config', () => {
    const capability = baseCapability({
      id: 'retrieve',
      storedKind: 'retrieve',
      targetKind: 'source_scope',
      inputSchema: { source: 'static', schema: { fields: ['query'] } },
      settingsFields: [
        { key: 'sourceScope', label: 'Source scope', type: 'source_scope' },
        { key: 'instruction', label: 'Instruction', type: 'textarea' },
        { key: 'retrievalStrategy', label: 'Retrieval strategy', type: 'select', options: [{ value: 'fixed', label: 'Fixed' }] },
        { key: 'vectorTopK', label: 'Vector top K', type: 'number', min: 1, max: 300 },
        { key: 'rerankEnabled', label: 'Rerank', type: 'boolean' },
      ],
      targets: [
        { id: '11111111-1111-4111-8111-111111111111', label: 'Course guide' },
      ],
    })
    const draft = createInitialSkillDraft([capability], baseSkill({
      capability: 'retrieve',
      storedKind: 'retrieve',
      target: { kind: 'source_scope', id: null },
      config: {
        sourceScope: { sourceIds: ['11111111-1111-4111-8111-111111111111'] },
        instruction: 'Use course sources only.',
        retrievalStrategy: 'fixed',
        vectorTopK: 12,
        rerankEnabled: true,
        exposedInputs: { query: true },
      },
    }))

    expect(draft.settingDrafts).toEqual({
      sourceScope: { mode: 'selected', sourceIds: ['11111111-1111-4111-8111-111111111111'] },
      instruction: 'Use course sources only.',
      retrievalStrategy: 'fixed',
      vectorTopK: 12,
      rerankEnabled: true,
    })
    expect(draft.extraConfigJson).toBe('{}')
  })

  it('maps typed descriptor settings into capability config', () => {
    const capability = baseCapability({
      id: 'notify',
      storedKind: 'notify',
      targetKind: 'notify_delivery',
      requiresTarget: false,
      inputSchema: { source: 'static', schema: { fields: ['message', 'email'], required: ['message'] } },
      settingsFields: [
        { key: 'delivery.recipientEmails', label: 'Recipient emails', type: 'string_list' },
        { key: 'delivery.webhook.url', label: 'Webhook URL', type: 'text' },
      ],
      targets: [],
    })
    const draft = createInitialSkillDraft([capability], null)
    draft.name = 'contact_human'
    draft.settingDrafts = {
      'delivery.recipientEmails': ['sales@example.com', 'support@example.com'],
      'delivery.webhook.url': 'https://hooks.example.com/contact',
    }
    draft.inputDrafts.message = { mode: 'expose', boundValue: '', description: '', slotBinding: 'message' }

    expect(buildAgentSkillInput(capability, draft, deriveSkillFields(capability))).toMatchObject({
      target: { kind: 'notify_delivery', id: null },
      config: {
        delivery: {
          recipientEmails: ['sales@example.com', 'support@example.com'],
          webhook: { url: 'https://hooks.example.com/contact' },
        },
        exposedInputs: {
          message: true,
        },
      },
    })
  })

  it('does not persist unset boolean defaults', () => {
    const capability = baseCapability({
      id: 'retrieve',
      storedKind: 'retrieve',
      targetKind: 'source_scope',
      requiresTarget: false,
      inputSchema: { source: 'static', schema: { fields: [] } },
      settingsFields: [
        { key: 'rerankEnabled', label: 'Rerank results', type: 'boolean', defaultValue: true },
      ],
      targets: [],
    })
    const draft = createInitialSkillDraft([capability], null)
    draft.name = 'retrieve_answer'

    expect(buildAgentSkillInput(capability, draft, deriveSkillFields(capability)).config).not.toHaveProperty('rerankEnabled')
  })

  it('persists explicit boolean overrides from unset defaults', () => {
    const capability = baseCapability({
      id: 'retrieve',
      storedKind: 'retrieve',
      targetKind: 'source_scope',
      requiresTarget: false,
      inputSchema: { source: 'static', schema: { fields: [] } },
      settingsFields: [
        { key: 'rerankEnabled', label: 'Rerank results', type: 'boolean', defaultValue: true },
      ],
      targets: [],
    })
    const draft = createInitialSkillDraft([capability], null)
    draft.name = 'retrieve_answer'
    draft.settingDrafts.rerankEnabled = false

    expect(buildAgentSkillInput(capability, draft, deriveSkillFields(capability)).config).toMatchObject({
      rerankEnabled: false,
    })
  })

  it('clears reset boolean and default select values before persisting config', () => {
    const capability = baseCapability({
      id: 'retrieve',
      storedKind: 'retrieve',
      targetKind: 'source_scope',
      requiresTarget: false,
      inputSchema: { source: 'static', schema: { fields: [] } },
      settingsFields: [
        { key: 'rerankEnabled', label: 'Rerank results', type: 'boolean', defaultValue: true },
        {
          key: 'retrievalStrategy',
          label: 'Retrieval strategy',
          type: 'select',
          defaultValue: 'fixed',
          options: [{ value: 'fixed', label: 'Fixed' }],
        },
      ],
      targets: [],
    })
    const draft = createInitialSkillDraft([capability], null)
    draft.name = 'retrieve_answer'
    draft.settingDrafts.rerankEnabled = undefined
    draft.settingDrafts.retrievalStrategy = undefined

    expect(buildAgentSkillInput(capability, draft, deriveSkillFields(capability)).config).not.toMatchObject({
      rerankEnabled: expect.anything(),
      retrievalStrategy: expect.anything(),
    })
  })

  it('keeps genuinely unknown config in the JSON escape hatch only', () => {
    const capability = baseCapability({
      settingsFields: [{ key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'send', label: 'Send' }] }],
    })
    const draft = createInitialSkillDraft([capability], baseSkill({
      config: {
        mode: 'send',
        customProviderOption: 'preserve',
        boundInputs: { subject: 'Follow up' },
        exposedInputs: { to: { slotBinding: 'email' }, bodyText: { slotBinding: 'message' } },
      },
    }))

    expect(draft.settingDrafts.mode).toBe('send')
    expect(draft.extraConfigJson).toBe(JSON.stringify({ customProviderOption: 'preserve' }, null, 2))
  })

  it('round-trips API-authored webhook payload entries that have no form row', () => {
    const capability = webhookCapability()
    const boundPayload = {
      calendar_context: {
        timezone: 'Europe/Tallinn',
        durationOptions: [30, 60],
        allowWaitlist: false,
        fallback: null,
      },
    }
    const exposedPayload = {
      calendar_date: {
        description: 'The date the customer wants',
        slotBinding: 'requested_date',
        required: true,
      },
      haircut_style: {
        description: 'The requested haircut style',
        required: false,
      },
      notes: {},
    }
    const draft = createInitialSkillDraft([capability], webhookSkill({
      boundPayload,
      exposedPayload,
      providerOption: 'preserve',
    }))

    expect(JSON.parse(draft.extraConfigJson)).toEqual({
      boundPayload,
      exposedPayload,
      providerOption: 'preserve',
    })

    draft.enabled = false

    expect(buildAgentSkillInput(capability, draft, deriveSkillFields(capability)).config).toEqual({
      boundPayload,
      exposedPayload: {
        ...exposedPayload,
        payload: {
          description: 'Payload',
          slotBinding: 'payload',
          required: true,
        },
      },
      providerOption: 'preserve',
    })
  })

  it('persists intentional Additional settings edits to unrendered webhook payload entries', () => {
    const capability = webhookCapability()
    const draft = createInitialSkillDraft([capability], webhookSkill({
      boundPayload: {
        calendar_context: { timezone: 'UTC', durationOptions: [30] },
      },
      exposedPayload: {
        calendar_date: { description: 'Original date', required: true },
        haircut_style: { description: 'Keep this sibling', required: false },
      },
    }))
    const additionalSettings = JSON.parse(draft.extraConfigJson) as {
      boundPayload: Record<string, unknown>
      exposedPayload: Record<string, unknown>
    }
    additionalSettings.boundPayload.calendar_context = {
      timezone: 'Europe/Tallinn',
      durationOptions: [30, 60],
    }
    additionalSettings.boundPayload.calendar_date = 'overlap remains for server validation'
    additionalSettings.exposedPayload.calendar_date = {
      description: 'Edited date',
      slotBinding: 'requested_date',
      required: true,
    }
    draft.extraConfigJson = JSON.stringify(additionalSettings)

    expect(buildAgentSkillInput(capability, draft, deriveSkillFields(capability)).config).toMatchObject({
      boundPayload: {
        calendar_context: { timezone: 'Europe/Tallinn', durationOptions: [30, 60] },
        calendar_date: 'overlap remains for server validation',
      },
      exposedPayload: {
        calendar_date: {
          description: 'Edited date',
          slotBinding: 'requested_date',
          required: true,
        },
        haircut_style: { description: 'Keep this sibling', required: false },
      },
    })
  })

  it('keeps malformed webhook payload maps visible for existing validation', () => {
    const capability = webhookCapability()
    const draft = createInitialSkillDraft([capability], webhookSkill({
      boundPayload: null,
      exposedPayload: ['invalid exposed payload'],
    }))

    expect(JSON.parse(draft.extraConfigJson)).toEqual({
      boundPayload: null,
      exposedPayload: ['invalid exposed payload'],
    })
    expect(buildAgentSkillInput(capability, draft, deriveSkillFields(capability)).config).toEqual({
      boundPayload: null,
      exposedPayload: ['invalid exposed payload'],
    })
  })

  it('makes rendered webhook fields authoritative without replacing hidden siblings', () => {
    const capability = webhookCapability()
    const draft = createInitialSkillDraft([capability], webhookSkill({
      boundPayload: { hidden_bound: { nested: true } },
      exposedPayload: {
        hidden_exposed: { description: 'Keep me', required: false },
        payload: { description: 'Current rendered value', required: true },
      },
    }))
    expect(JSON.parse(draft.extraConfigJson)).toEqual({
      boundPayload: { hidden_bound: { nested: true } },
      exposedPayload: { hidden_exposed: { description: 'Keep me', required: false } },
    })
    draft.extraConfigJson = JSON.stringify({
      boundPayload: {
        hidden_bound: { nested: true },
        payload: 'stale bound value',
      },
      exposedPayload: {
        hidden_exposed: { description: 'Keep me', required: false },
        payload: { description: 'Stale exposed value', required: true },
      },
    })
    draft.inputDrafts.payload = {
      mode: 'bind',
      boundValue: 'fresh bound value',
      description: '',
      slotBinding: 'payload',
    }

    expect(buildAgentSkillInput(capability, draft, deriveSkillFields(capability)).config).toEqual({
      boundPayload: {
        hidden_bound: { nested: true },
        payload: 'fresh bound value',
      },
      exposedPayload: {
        hidden_exposed: { description: 'Keep me', required: false },
      },
    })

    draft.inputDrafts.payload.mode = 'ignore'
    const ignoredConfig = buildAgentSkillInput(capability, draft, deriveSkillFields(capability)).config

    expect(ignoredConfig.boundPayload).toEqual({ hidden_bound: { nested: true } })
    expect(ignoredConfig.exposedPayload).toEqual({
      hidden_exposed: { description: 'Keep me', required: false },
    })
  })

  it('uses discovered schemas for MCP-style inputs and declared outcomes', () => {
    const capability = baseCapability({
      id: 'mcp_tool',
      storedKind: 'external_mcp',
      targetKind: 'mcp_connection',
      inputSchema: { source: 'discovered' },
      outcomeVocabulary: ['completed', 'failed'],
      targets: [{ id: 'mcp-1', label: 'Support MCP' }],
    })
    const fields = deriveSkillFields(capability, {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string', description: 'Message text' },
        urgent: { type: 'boolean' },
      },
    })
    const draft = createInitialSkillDraft([capability], null)
    draft.name = 'post_message'
    draft.targetId = 'mcp-1'
    draft.toolName = 'post_message'
    draft.inputDrafts = {
      message: { mode: 'expose', boundValue: '', description: 'Message text', slotBinding: 'message' },
      urgent: { mode: 'bind', boundValue: 'true', description: '', slotBinding: 'urgent' },
    }

    expect(buildAgentSkillInput(capability, draft, fields).config).toEqual({
      toolName: 'post_message',
      boundParams: { urgent: true },
      exposedParams: { message: { description: 'Message text', slotBinding: 'message', required: true } },
      declaredOutcomes: ['completed', 'failed'],
    })
  })
})
