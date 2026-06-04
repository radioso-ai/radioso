import { describe, expect, it } from 'vitest'

import { createDefaultMetadataRule } from '@/components/dashboard/settings/retrieval-rule-helpers'
import {
  readRetrievalSkillSettingsOverride,
  RETRIEVAL_ANSWER_SKILL_NAME,
  writeRetrievalSkillSettingsOverride,
} from '@/lib/retrieval-skill-settings'

describe('retrieval skill settings adapter', () => {
  it('reads only the typed retrieval.answer override fields from the opaque skill settings map', () => {
    expect(readRetrievalSkillSettingsOverride({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        customInstruction: 'Prefer product docs.',
        queryRewriteEnabled: false,
        metadataRules: [
          {
            id: 'rule-1',
            field: 'region',
            operator: 'equals',
            valueType: 'string',
            value: 'eu',
            effect: 'boost',
            enabled: true,
            triggerMode: 'always_on',
          },
        ],
        suggestedQuestionsCount: 4,
        retrievalStrategy: 'reasoning',
        similarityThreshold: 0.9,
        vectorTopK: 'many',
      },
      'human_contact.request': { enabled: true },
    })).toEqual({
      queryRewriteEnabled: false,
      metadataRules: [
        {
          id: 'rule-1',
          field: 'region',
          operator: 'equals',
          valueType: 'string',
          value: 'eu',
          effect: 'boost',
          enabled: true,
          triggerMode: 'always_on',
        },
      ],
      suggestedQuestionsCount: 4,
      retrievalStrategy: 'reasoning',
    })
  })

  it('writes retrieval.answer without disturbing other skill settings', () => {
    expect(writeRetrievalSkillSettingsOverride({
      'human_contact.request': { enabled: true },
    }, {
      vectorTopK: 12,
    })).toEqual({
      'human_contact.request': { enabled: true },
      [RETRIEVAL_ANSWER_SKILL_NAME]: { vectorTopK: 12 },
    })
  })

  it('writes managed metadataRules overrides', () => {
    const metadataRules = [{
      id: 'rule-1',
      field: 'region',
      operator: 'equals',
      valueType: 'string',
      value: 'eu',
      effect: 'boost',
      enabled: true,
      triggerMode: 'always_on',
    }] as const

    expect(writeRetrievalSkillSettingsOverride(undefined, {
      metadataRules: [...metadataRules],
    })).toEqual({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        metadataRules: [...metadataRules],
      },
    })
  })

  it('clears managed metadataRules while preserving unmanaged sibling fields', () => {
    const metadataRules = [{
      id: 'rule-1',
      field: 'region',
      operator: 'equals',
      valueType: 'string',
      value: 'eu',
      effect: 'boost',
      enabled: true,
      triggerMode: 'always_on',
    }]

    expect(writeRetrievalSkillSettingsOverride({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        metadataRules,
        someFutureField: { enabled: true },
        customInstruction: 'Prefer release notes.',
      },
    }, {})).toEqual({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        someFutureField: { enabled: true },
        customInstruction: 'Prefer release notes.',
      },
    })
  })

  it('preserves unmanaged customInstruction and future retrieval.answer fields when saving managed overrides', () => {
    expect(writeRetrievalSkillSettingsOverride({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        someFutureField: { enabled: true },
        customInstruction: 'Prefer release notes.',
      },
    }, {
      vectorTopK: 12,
    })).toEqual({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        someFutureField: { enabled: true },
        customInstruction: 'Prefer release notes.',
        vectorTopK: 12,
      },
    })
  })

  it('removes retrieval.answer when all field overrides are cleared', () => {
    expect(writeRetrievalSkillSettingsOverride({
      'human_contact.request': { enabled: true },
      [RETRIEVAL_ANSWER_SKILL_NAME]: { vectorTopK: 12 },
    }, {})).toEqual({
      'human_contact.request': { enabled: true },
    })
  })
})

describe('metadata rule defaults', () => {
  it('creates the add-rule CTA rule from field suggestions', () => {
    const rule = createDefaultMetadataRule([{ field: 'isPublic', inferredType: 'boolean' }])

    expect(rule).toMatchObject({
      field: 'isPublic',
      valueType: 'boolean',
      operator: 'equals',
      value: 'true',
      effect: 'boost',
      enabled: true,
      triggerMode: 'always_on',
    })
    expect(rule.conditions).toMatchObject([
      {
        field: 'isPublic',
        valueType: 'boolean',
        operator: 'equals',
        value: 'true',
      },
    ])
  })
})
