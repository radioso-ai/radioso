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
        suggestedQuestionsCount: 4,
        retrievalStrategy: 'reasoning',
        similarityThreshold: 0.9,
        vectorTopK: 'many',
      },
      'human_contact.request': { enabled: true },
    })).toEqual({
      customInstruction: 'Prefer product docs.',
      queryRewriteEnabled: false,
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

  it('preserves sibling retrieval.answer fields when saving a behavioral override', () => {
    const metadataRules = [
      {
        id: 'rule-1',
        field: 'region',
        operator: 'equals',
        value: 'eu',
        effect: 'boost',
      },
    ]

    expect(writeRetrievalSkillSettingsOverride({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        metadataRules,
      },
    }, {
      customInstruction: 'Prefer release notes.',
    })).toEqual({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        metadataRules,
        customInstruction: 'Prefer release notes.',
      },
    })
  })

  it('keeps retrieval.answer when clearing UI-managed fields leaves preserved fields behind', () => {
    const metadataRules = [
      {
        id: 'rule-1',
        field: 'region',
        operator: 'equals',
        value: 'eu',
        effect: 'boost',
      },
    ]

    expect(writeRetrievalSkillSettingsOverride({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        metadataRules,
        customInstruction: 'Prefer release notes.',
      },
    }, {})).toEqual({
      [RETRIEVAL_ANSWER_SKILL_NAME]: {
        metadataRules,
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
