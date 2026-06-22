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
