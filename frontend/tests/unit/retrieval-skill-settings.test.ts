import { describe, expect, it } from 'vitest'

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
      customInstruction: 'Prefer release notes.',
    })).toEqual({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        metadataRules: [...metadataRules],
        customInstruction: 'Prefer release notes.',
      },
    })
  })

  it('clears managed metadataRules while preserving future sibling fields', () => {
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
      },
    })
  })

  it('preserves genuinely unknown retrieval.answer fields when saving managed overrides', () => {
    expect(writeRetrievalSkillSettingsOverride({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        someFutureField: { enabled: true },
      },
    }, {
      customInstruction: 'Prefer release notes.',
    })).toEqual({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        someFutureField: { enabled: true },
        customInstruction: 'Prefer release notes.',
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
