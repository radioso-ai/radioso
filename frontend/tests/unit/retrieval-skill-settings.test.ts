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

  it('removes retrieval.answer when all field overrides are cleared', () => {
    expect(writeRetrievalSkillSettingsOverride({
      'human_contact.request': { enabled: true },
      [RETRIEVAL_ANSWER_SKILL_NAME]: { vectorTopK: 12 },
    }, {})).toEqual({
      'human_contact.request': { enabled: true },
    })
  })
})
