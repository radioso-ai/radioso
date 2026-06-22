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
        { id: 'all', label: 'All sources' },
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
      inputSchema: { source: 'static', schema: { fields: ['message', 'email'] } },
      settingsFields: [
        { key: 'delivery.recipientEmails', label: 'Recipient emails', type: 'string_list' },
        { key: 'delivery.webhook.url', label: 'Webhook URL', type: 'text' },
      ],
      targets: [{ id: 'default', label: 'Configured delivery' }],
    })
    const draft = createInitialSkillDraft([capability], null)
    draft.name = 'contact_human'
    draft.settingDrafts = {
      'delivery.recipientEmails': ['sales@example.com', 'support@example.com'],
      'delivery.webhook.url': 'https://hooks.example.com/contact',
    }
    draft.inputDrafts.message = { mode: 'expose', boundValue: '', description: '', slotBinding: 'message' }

    expect(buildAgentSkillInput(capability, draft, deriveSkillFields(capability)).config).toEqual({
      delivery: {
        recipientEmails: ['sales@example.com', 'support@example.com'],
        webhook: { url: 'https://hooks.example.com/contact' },
      },
      exposedInputs: {
        message: true,
        email: true,
      },
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
