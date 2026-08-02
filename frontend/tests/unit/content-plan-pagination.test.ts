import { describe, expect, it } from 'vitest'

import type {
  ContentPlanPage,
  ContentPlanTopicSummary,
} from '@/lib/api-content-plan'
import {
  hasCopyableContentPlanBrief,
  mergeContentPlanPage,
} from '@/lib/content-plan'

describe('content plan pagination', () => {
  it('appends unique topics while preserving the first-page report snapshot', () => {
    const firstPage = page({
      items: [topic('topic-a', 'Original topic A')],
      recommendedTopicId: 'topic-a',
      nextCursor: 'cursor-2',
    })
    const nextPage = page({
      items: [topic('topic-a', 'Duplicate topic A'), topic('topic-b', 'Topic B')],
      recommendedTopicId: 'topic-b',
      nextCursor: 'cursor-3',
    })
    nextPage.summary.questionCount = 999
    nextPage.emerging = []

    const merged = mergeContentPlanPage(firstPage, nextPage)

    expect(merged.items.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'topic-a', label: 'Original topic A' },
      { id: 'topic-b', label: 'Topic B' },
    ])
    expect(merged.summary).toBe(firstPage.summary)
    expect(merged.emerging).toBe(firstPage.emerging)
    expect(merged.recommendedTopicId).toBe('topic-a')
    expect(merged.nextCursor).toBe('cursor-3')
  })

  it('only treats a populated generated brief as copyable', () => {
    const recommendation = topic('topic-a', 'Topic A').recommendation

    expect(hasCopyableContentPlanBrief(recommendation)).toBe(false)
    expect(hasCopyableContentPlanBrief({
      ...recommendation,
      state: 'unavailable',
      action: 'add_content',
    })).toBe(false)
    expect(hasCopyableContentPlanBrief({
      ...recommendation,
      state: 'ready',
      action: 'add_content',
      rationale: 'Visitors repeatedly ask about this gap.',
      suggestedTitle: 'A useful guide',
      questionsToAnswer: ['What should visitors know?'],
      suggestedShape: 'guide',
      evidenceStatement: 'Three measured conversations show the gap.',
    })).toBe(true)
  })
})

function page({
  items,
  recommendedTopicId,
  nextCursor,
}: {
  items: ContentPlanTopicSummary[]
  recommendedTopicId: string | null
  nextCursor: string | null
}): ContentPlanPage {
  return {
    range: '30d',
    window: { from: '2026-07-03T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
    comparisonWindow: { from: '2026-06-03T00:00:00.000Z', to: '2026-07-03T00:00:00.000Z' },
    asOf: '2026-08-02T00:00:00.000Z',
    projection: {
      state: 'ready',
      processedThrough: '2026-08-02T00:00:00.000Z',
      processingLagSeconds: 0,
      pendingEmbeddingCount: 0,
      pendingAssignmentCount: 0,
      pendingEnrichmentTopicCount: 0,
      processedCount: null,
      totalCount: null,
      embeddingSpaceFingerprint: 'space-1',
      reason: null,
    },
    summary: {
      questionCount: 10,
      conversationCount: 8,
      matureTopicCount: 2,
      emergingQuestionCount: 1,
      opportunityCount: 1,
      grounding: {
        evaluatedAnswerCount: 5,
        groundedAnswerCount: 2,
        degradedAnswerCount: 1,
        noSupportAnswerCount: 2,
        notEvaluatedAnswerCount: 5,
        reducedOrNoSupportRate: 0.6,
        headlineState: 'measured',
      },
    },
    rankingVersion: 1,
    recommendedTopicId,
    items,
    emerging: [{
      observationId: 'observation-1',
      question: 'An emerging question',
      sourceAvailable: true,
      conversationId: 'conversation-1',
      assistantMessageId: 'message-1',
      questionCount: 1,
      conversationCount: 1,
      observedAt: '2026-08-02T00:00:00.000Z',
      state: 'emerging',
    }],
    nextCursor,
  }
}

function topic(id: string, label: string): ContentPlanTopicSummary {
  return {
    id,
    lifecycle: 'mature',
    label,
    description: null,
    labelState: 'ready',
    demand: {
      currentQuestionCount: 1,
      comparisonQuestionCount: 0,
      currentConversationCount: 1,
      comparisonConversationCount: 0,
      currentShare: 1,
      absoluteChange: 1,
      trend: 'new',
    },
    grounding: {
      groundedAnswerCount: 0,
      degradedAnswerCount: 0,
      noSupportAnswerCount: 0,
      notEvaluatedAnswerCount: 1,
      evaluatedAnswerCount: 0,
      reducedOrNoSupportRate: null,
      headlineState: 'unmeasured',
    },
    evidence: {
      strength: 'none',
      evaluatedConversationCount: 0,
      activeGapConversationCount: 0,
    },
    opportunity: { credible: false, priorityReasons: [] },
    recommendation: {
      action: null,
      state: 'pending',
      rationale: null,
      suggestedTitle: null,
      questionsToAnswer: [],
      suggestedShape: null,
      evidenceStatement: null,
      factsMustBeVerified: true,
    },
    corpusEvidence: {
      state: 'pending',
      relatedDocumentCount: 0,
      actionRuleVersion: 1,
    },
    affected: { agentCount: 0, channelCount: 0 },
    updatedAt: '2026-08-02T00:00:00.000Z',
  }
}
