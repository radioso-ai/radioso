import { describe, expect, it } from 'vitest'

import {
  buildAgentSkillInput,
  createInitialSkillDraft,
  deriveSkillFields,
} from '@/components/dashboard/settings/skills/skill-form-model'
import { createDefaultMetadataRule } from '@/components/dashboard/settings/retrieval-rule-helpers'
import type { AgentSkill, SkillCapabilityDescriptor } from '@/lib/api-skills'

const retrieveCapability = (input: Partial<SkillCapabilityDescriptor> = {}): SkillCapabilityDescriptor => ({
  id: 'retrieve',
  storedKind: 'retrieve',
  targetKind: 'source_scope',
  requiresTarget: false,
  inputSchema: { source: 'static', schema: { fields: ['query'] } },
  settingsFields: [
    { key: 'metadataRules', label: 'Metadata rules', type: 'metadata_rules' },
  ],
  outcomeVocabulary: ['found', 'empty'],
  supportedInvocationModes: ['default_answer', 'routine_named'],
  executorAdapter: 'retrieval_answer',
  targets: [],
  available: true,
  unavailableReason: null,
  ...input,
})

const retrieveSkill = (input: Partial<AgentSkill> = {}): AgentSkill => ({
  id: 'skill-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'retrieve_answer',
  capability: 'retrieve',
  storedKind: 'retrieve',
  target: { kind: 'source_scope', id: null },
  config: {},
  invocationMode: 'default_answer',
  enabled: true,
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
  ...input,
})

describe('skill form model metadata rules', () => {
  it('maps a metadata-rules draft into capability config', () => {
    const capability = retrieveCapability()
    const rule = createDefaultMetadataRule([])
    const draft = createInitialSkillDraft([capability], null)
    draft.name = 'retrieve_answer'
    draft.settingDrafts.metadataRules = [rule]

    const config = buildAgentSkillInput(capability, draft, deriveSkillFields(capability)).config
    expect(config.metadataRules).toEqual([rule])
  })

  it('hydrates a metadata-rules draft from existing config', () => {
    const capability = retrieveCapability()
    const rule = createDefaultMetadataRule([])
    const draft = createInitialSkillDraft([capability], retrieveSkill({
      config: { metadataRules: [rule] },
    }))

    expect(draft.settingDrafts.metadataRules).toEqual([rule])
  })
})
