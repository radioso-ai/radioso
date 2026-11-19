import { describe, expect, it } from 'vitest'

import type {
  AudiencePulseContentGap,
  AudiencePulseHydratedReport,
  AudiencePulseRecommendation,
  AudiencePulseTheme,
  AudiencePulseThemeEvidence,
} from '@/lib/api-audience-pulse'
import { contentQueue, topicKeepsState } from '@/lib/audience-pulse-queue'

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

const TRAVEL = '11111111-1111-4111-8111-000000000001'
const FOOD = '11111111-1111-4111-8111-000000000002'
const ROOMS = '11111111-1111-4111-8111-000000000003'

const travel = theme(TRAVEL, 'Getting to the retreat centre', {
  evidence: [
    evidence('ev-1', 'Is there a bus?', 'unanswered'),
    evidence('ev-2', 'Can I cycle there?', 'answered'),
    evidence('ev-3', 'Where is the gate?', 'partial'),
    evidence('ev-4', 'Is there a bus?', 'partial'),
  ],
})
const food = theme(FOOD, 'Food and dietary needs')
const rooms = theme(ROOMS, 'Accommodation and rooms')

describe('contentQueue', () => {
  it('ranks the topics in the queue by how many questions had no answer in your content', () => {
    const queue = contentQueue(report({
      themes: [travel, food, rooms],
      contentGaps: [gap(FOOD, 12), gap(TRAVEL, 40), gap(ROOMS, 20)],
    }), {})

    expect(queue.items.map((item) => [item.topicId, item.noAnswerCount])).toEqual([
      [TRAVEL, 40],
      [ROOMS, 20],
      [FOOD, 12],
    ])
  })

  it('titles a row with its recommendation, else its topic, and always names the topic', () => {
    const queue = contentQueue(report({
      themes: [travel, food],
      contentGaps: [gap(TRAVEL, 40), gap(FOOD, 12)],
      recommendations: [recommendation(TRAVEL, 'Directions and transfers')],
    }), {})

    expect(queue.items.map((item) => [item.title, item.topicTitle])).toEqual([
      ['Directions and transfers', 'Getting to the retreat centre'],
      ['Food and dietary needs', 'Food and dietary needs'],
    ])
  })

  it('lists the recommendation questions, else the topic questions with no or a partial answer', () => {
    const withRecommendation = contentQueue(report({
      themes: [travel],
      contentGaps: [gap(TRAVEL, 40)],
      recommendations: [recommendation(TRAVEL, 'Directions and transfers')],
    }), {})
    const withoutRecommendation = contentQueue(report({
      themes: [travel],
      contentGaps: [gap(TRAVEL, 40)],
    }), {})

    expect(withRecommendation.items[0].questions).toEqual(['Is there a shuttle?', 'Where do I park?'])
    expect(withRecommendation.items[0].rationale).toBe('Your documents say nothing about it.')
    expect(withoutRecommendation.items[0].questions).toEqual(['Is there a bus?', 'Where is the gate?'])
    expect(withoutRecommendation.items[0].rationale).toBeNull()
  })

  it('seeds a draft from the recommendation, else from the topic and its questions, keyed to the topic', () => {
    const queue = contentQueue(report({
      themes: [travel, food],
      contentGaps: [gap(TRAVEL, 40), gap(FOOD, 12)],
      recommendations: [recommendation(TRAVEL, 'Directions and transfers')],
    }), {})

    expect(queue.items[0].draftSeed).toEqual({
      title: 'Directions and transfers (draft)',
      questions: ['Is there a shuttle?', 'Where do I park?', 'How long is the ride?'],
      topicId: TRAVEL,
    })
    expect(queue.items[1].draftSeed).toEqual({ title: 'Food and dietary needs', questions: [], topicId: FOOD })
  })

  it('leaves out dismissed topics, with the operator’s latest choice winning over the saved one', () => {
    const contentGaps = [
      gap(TRAVEL, 40),
      gap(FOOD, 12, { dismissedAt: '2026-11-18T10:00:00.000Z' }),
      gap(ROOMS, 20, { dismissedAt: '2026-11-18T10:00:00.000Z' }),
    ]
    const saved = contentQueue(report({ themes: [travel, food, rooms], contentGaps }), {})
    const changed = contentQueue(report({ themes: [travel, food, rooms], contentGaps }), { [TRAVEL]: true, [ROOMS]: false })

    expect(saved.items.map((item) => item.topicId)).toEqual([TRAVEL])
    expect(saved.dismissedTopicIds).toEqual([FOOD, ROOMS])
    expect(changed.items.map((item) => item.topicId)).toEqual([ROOMS])
    expect(changed.dismissedTopicIds).toEqual([TRAVEL, FOOD])
  })

  it('carries the latest draft and counts the questions the queue covers', () => {
    const queue = contentQueue(report({
      themes: [travel, food],
      contentGaps: [
        gap(TRAVEL, 40, { latestDraft: { documentId: 'cccccccc-cccc-4ccc-8ccc-000000000001', createdAt: '2026-11-12T09:00:00.000Z' } }),
        gap(FOOD, 12, { latestDraft: undefined, dismissedAt: undefined }),
      ],
    }), {})

    expect(queue.items[0].latestDraft?.createdAt).toBe('2026-11-12T09:00:00.000Z')
    expect(queue.items[1].latestDraft).toBeNull()
    expect(queue.noAnswerCount).toBe(52)
  })

  it('skips a gap whose topic is not in the report', () => {
    expect(contentQueue(report({ themes: [food], contentGaps: [gap('gone', 50), gap(FOOD, 12)] }), {}).items)
      .toHaveLength(1)
  })

  it('keeps no operator state for a legacy topic id, while Draft still seeds the document', () => {
    const legacy = theme('theme-1', 'Refund timing')
    const queue = contentQueue(report({
      themes: [legacy, food],
      contentGaps: [gap('theme-1', 40), gap(FOOD, 12)],
    }), {})

    expect(queue.items.map((item) => [item.topicId, item.keepsState])).toEqual([['theme-1', false], [FOOD, true]])
    expect(queue.items[0].draftSeed).toEqual({ title: 'Refund timing', questions: [] })
    expect(queue.items[1].draftSeed.topicId).toBe(FOOD)
  })
})

describe('topicKeepsState', () => {
  it('accepts a UUID and nothing else', () => {
    expect(topicKeepsState(TRAVEL)).toBe(true)
    expect(topicKeepsState(TRAVEL.toUpperCase())).toBe(true)
    expect(topicKeepsState('theme-1')).toBe(false)
    expect(topicKeepsState(`${TRAVEL}x`)).toBe(false)
  })
})
