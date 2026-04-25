import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ChatRetrievalInfo } from '@/components/dashboard/chat-retrieval-info'
import { ChatRetrievalTraceDetail } from '@/components/dashboard/chat-retrieval-trace-detail'
import { ChatRetrievalTraceGraph } from '@/components/dashboard/chat-retrieval-trace-graph'
import type { RetrievalInfo, RetrievalTrace } from '@/lib/api'

const retrievalInfo: RetrievalInfo = {
  candidateCounts: {
    semantic: 2,
    lexical: 1,
    merged: 2,
    final: 1,
  },
  fallbackApplied: false,
  rerankStatus: 'skipped',
  triggerAnalysis: {
    status: 'applied',
    consideredRules: [
      {
        ruleId: 'events-only',
        matched: true,
        matchStrength: 0.96,
        reason: 'The question is explicitly about an upcoming event.',
        triggerInstructionPreview: 'Enact when the user is asking about upcoming events.',
      },
    ],
    matchedRuleIds: ['events-only'],
    unmatchedRuleIds: [],
    matchCount: 1,
    matcherVersion: 'test',
  },
  triggerBackoff: {
    applied: true,
    reason: 'empty_filtered_candidates',
    relaxedRuleIds: ['events-only'],
    restoredCandidateCount: 3,
  },
}

const retrievalTrace: RetrievalTrace = {
  traceId: 'trace-1',
  startedAt: '2026-04-23T10:00:00.000Z',
  stages: [
    {
      stageId: 'trigger_analysis',
      kind: 'trigger_analysis',
      label: 'Trigger analysis',
      status: 'applied',
      inputs: {
        query: 'When is the next conference?',
      },
      outputs: {
        consideredRules: retrievalInfo.triggerAnalysis?.consideredRules,
        matchedRuleIds: retrievalInfo.triggerAnalysis?.matchedRuleIds,
        unmatchedRuleIds: retrievalInfo.triggerAnalysis?.unmatchedRuleIds,
        backoffDecision: retrievalInfo.triggerBackoff,
      },
      metrics: {
        consideredRuleCount: 1,
        matchCount: 1,
      },
    },
    {
      stageId: 'answer',
      kind: 'answer_outcome',
      label: 'Answer outcome',
      status: 'applied',
      outputs: {
        outcome: 'grounded_success',
        validationRan: true,
        supportedSegmentCount: 2,
        unsupportedSegmentCount: 0,
        hiddenSupportUsed: true,
        hiddenSupportKindsUsed: ['assistant_name', 'assistant_role'],
      },
    },
    {
      stageId: 'preparation',
      kind: 'candidate_preparation',
      label: 'Candidate preparation',
      status: 'fallback',
      metrics: {
        mergedCount: 3,
      },
    },
  ],
  links: [
    { fromStageId: 'trigger_analysis', toStageId: 'preparation', kind: 'sequence' },
  ],
  summary: retrievalInfo,
}

describe('retrieval diagnostics surfaces', () => {
  it('renders trigger summaries and backoff details', () => {
    const html = renderToStaticMarkup(
      <ChatRetrievalInfo retrievalInfo={retrievalInfo} retrievalTrace={retrievalTrace} />
    )

    expect(html).toContain('Trigger analysis')
    expect(html).toContain('events-only')
    expect(html).toContain('Trigger backoff')
    expect(html).toContain('Restored candidates: 3')
  })

  it('renders the trigger analysis stage in the trace graph', () => {
    const html = renderToStaticMarkup(
      <ChatRetrievalTraceGraph
        retrievalTrace={retrievalTrace}
        selectedStageId="trigger_analysis"
        onSelectStage={() => undefined}
      />
    )

    expect(html).toContain('Trigger analysis')
    expect(html).toContain('1 matched rule')
  })

  it('shows hidden support usage in the answer stage diagnostics', () => {
    const graphHtml = renderToStaticMarkup(
      <ChatRetrievalTraceGraph
        retrievalTrace={retrievalTrace}
        selectedStageId="answer"
        onSelectStage={() => undefined}
      />,
    )
    const detailHtml = renderToStaticMarkup(
      <ChatRetrievalTraceDetail retrievalTrace={retrievalTrace} selectedStageId="answer" />,
    )

    expect(graphHtml).toContain('hidden support')
    expect(detailHtml).toContain('Hidden support used')
    expect(detailHtml).toContain('assistant_name')
    expect(detailHtml).toContain('assistant_role')
  })
})
