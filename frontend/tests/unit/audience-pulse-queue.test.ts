import { describe, expect, it } from 'vitest'

import type {
  AudiencePulseContentGap,
  AudiencePulseHydratedReport,
  AudiencePulseRecommendation,
  AudiencePulseTheme,
  AudiencePulseThemeEvidence,
} from '@/lib/api-audience-pulse'
import { contentQueue } from '@/lib/audience-pulse-queue'

const evidence = (
  reference: string,
  question: string,
  answerStatus: AudiencePulseThemeEvidence['answerStatus'],
): AudiencePulseThemeEvidence => ({
  reference,
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
  question,
  occurrenceCount: 1,
  answerStatus,
})

const theme = (id: string, title: string, overrides: Partial<AudiencePulseTheme> = {}): AudiencePulseTheme => ({
  id,
  title,
  description: '',
  memberCount: 100,
  previousMemberCount: null,
  previousShare: null,
  transition: null,
  share: 0.1,
  distinctQuestionCount: 10,
  weeklyPulse: [],
  grounding: { grounded: 0, degraded: 0, noSupport: 0, unknown: 0, contentGapEligible: 0 },
  answers: null,
  evidence: [],
  ...overrides,
})

const gap = (themeId: string, eligibleEvidenceCount: number, overrides: Partial<AudiencePulseContentGap> = {}): AudiencePulseContentGap => ({
  themeId,
  eligibleEvidenceCount,
  distinctConversationCount: eligibleEvidenceCount - 1,
  dismissedAt: null,
  latestDraft: null,
  ...overrides,
})

const recommendation = (themeId: string, title: string): AudiencePulseRecommendation => ({
  id: `rec-${themeId}`,
  themeId,
  title,
  rationale: 'Your documents say nothing about it.',
  questions: ['Is there a shuttle?', 'Where do I park?'],
  evidenceReferences: [],
  startDraft: { title: `${title} (draft)`, questions: ['Is there a shuttle?', 'Where do I park?', 'How long is the ride?'] },
})

const report = (overrides: Partial<AudiencePulseHydratedReport>): AudiencePulseHydratedReport => ({
  period: { start: '2026-10-20T00:00:00.000Z', end: '2026-11-19T00:00:00.000Z' },
  generatedAt: '2026-11-19T06:00:00.000Z',
  isFirstCensus: false,
  narrativeGeneratedAt: '2026-11-19T06:00:00.000Z',
  narrativeReuseCount: 0,
  coverage: { populationSize: 400, sampleSize: 400, sampled: false, facetReadyQuestionCount: 400 },
  weeklyVolume: [],
  dissolvedTopics: [],
  themes: [],
  contentGaps: [],
  recommendations: [],
  caveats: [],
  unclassifiedQuestionCount: 0,
  ...overrides,
})

const travel = theme('travel', 'Getting to the retreat centre', {
  evidence: [
    evidence('ev-1', 'Is there a bus?', 'unanswered'),
    evidence('ev-2', 'Can I cycle there?', 'answered'),
    evidence('ev-3', 'Where is the gate?', 'partial'),
    evidence('ev-4', 'Is there a bus?', 'partial'),
  ],
})
const food = theme('food', 'Food and dietary needs')
const rooms = theme('rooms', 'Accommodation and rooms')

describe('contentQueue', () => {
  it('ranks the topics in the queue by how many questions had no answer in your content', () => {
    const queue = contentQueue(report({
      themes: [travel, food, rooms],
      contentGaps: [gap('food', 12), gap('travel', 40), gap('rooms', 20)],
    }), {})

    expect(queue.items.map((item) => [item.topicId, item.noAnswerCount])).toEqual([
      ['travel', 40],
      ['rooms', 20],
      ['food', 12],
    ])
  })

  it('titles a row with its recommendation, else its topic, and always names the topic', () => {
    const queue = contentQueue(report({
      themes: [travel, food],
      contentGaps: [gap('travel', 40), gap('food', 12)],
      recommendations: [recommendation('travel', 'Directions and transfers')],
    }), {})

    expect(queue.items.map((item) => [item.title, item.topicTitle])).toEqual([
      ['Directions and transfers', 'Getting to the retreat centre'],
      ['Food and dietary needs', 'Food and dietary needs'],
    ])
  })

  it('lists the recommendation questions, else the topic questions with no or a partial answer', () => {
    const withRecommendation = contentQueue(report({
      themes: [travel],
      contentGaps: [gap('travel', 40)],
      recommendations: [recommendation('travel', 'Directions and transfers')],
    }), {})
    const withoutRecommendation = contentQueue(report({
      themes: [travel],
      contentGaps: [gap('travel', 40)],
    }), {})

    expect(withRecommendation.items[0].questions).toEqual(['Is there a shuttle?', 'Where do I park?'])
    expect(withRecommendation.items[0].rationale).toBe('Your documents say nothing about it.')
    expect(withoutRecommendation.items[0].questions).toEqual(['Is there a bus?', 'Where is the gate?'])
    expect(withoutRecommendation.items[0].rationale).toBeNull()
  })

  it('seeds a draft from the recommendation, else from the topic and its questions, keyed to the topic', () => {
    const queue = contentQueue(report({
      themes: [travel, food],
      contentGaps: [gap('travel', 40), gap('food', 12)],
      recommendations: [recommendation('travel', 'Directions and transfers')],
    }), {})

    expect(queue.items[0].draftSeed).toEqual({
      title: 'Directions and transfers (draft)',
      questions: ['Is there a shuttle?', 'Where do I park?', 'How long is the ride?'],
      topicId: 'travel',
    })
    expect(queue.items[1].draftSeed).toEqual({ title: 'Food and dietary needs', questions: [], topicId: 'food' })
  })

  it('leaves out dismissed topics, with the operator’s latest choice winning over the saved one', () => {
    const contentGaps = [
      gap('travel', 40),
      gap('food', 12, { dismissedAt: '2026-11-18T10:00:00.000Z' }),
      gap('rooms', 20, { dismissedAt: '2026-11-18T10:00:00.000Z' }),
    ]
    const saved = contentQueue(report({ themes: [travel, food, rooms], contentGaps }), {})
    const changed = contentQueue(report({ themes: [travel, food, rooms], contentGaps }), { travel: true, rooms: false })

    expect(saved.items.map((item) => item.topicId)).toEqual(['travel'])
    expect(saved.dismissedTopicIds).toEqual(['food', 'rooms'])
    expect(changed.items.map((item) => item.topicId)).toEqual(['rooms'])
    expect(changed.dismissedTopicIds).toEqual(['travel', 'food'])
  })

  it('carries the latest draft and counts the questions the queue covers', () => {
    const queue = contentQueue(report({
      themes: [travel, food],
      contentGaps: [
        gap('travel', 40, { latestDraft: { documentId: 'cccccccc-cccc-4ccc-8ccc-000000000001', createdAt: '2026-11-12T09:00:00.000Z' } }),
        gap('food', 12, { latestDraft: undefined, dismissedAt: undefined }),
      ],
    }), {})

    expect(queue.items[0].latestDraft?.createdAt).toBe('2026-11-12T09:00:00.000Z')
    expect(queue.items[1].latestDraft).toBeNull()
    expect(queue.noAnswerCount).toBe(52)
  })

  it('skips a gap whose topic is not in the report', () => {
    expect(contentQueue(report({ themes: [food], contentGaps: [gap('gone', 50), gap('food', 12)] }), {}).items)
      .toHaveLength(1)
  })
})
