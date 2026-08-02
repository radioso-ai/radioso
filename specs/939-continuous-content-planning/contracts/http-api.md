# HTTP Contract: Continuous Content Planning

All endpoints are session-authenticated, scoped to the active workspace, and require
`workspace.quality.read`. Unknown, foreign-workspace, retired, and unauthorized topic
IDs use the same `404` response. Reads do not create audit events.

## Shared enums

```ts
type ContentPlanView = 'opportunities' | 'all_interests'
type ProjectionState =
  | 'bootstrapping' | 'ready' | 'updating' | 'delayed'
  | 'reprojecting' | 'degraded' | 'budget_paused'
type TopicLifecycle = 'mature' | 'merged' // provisional uses emerging DTOs
type TopicTrend = 'new' | 'rising' | 'steady' | 'falling' | 'insufficient_data'
type EvidenceStrength = 'none' | 'low' | 'medium' | 'high'
type RecommendationAction =
  | 'add_content' | 'review_existing_content'
  | 'investigate_retrieval' | 'monitor'
type EnrichmentState =
  | 'pending' | 'ready' | 'stale' | 'unavailable' | 'outside_analysis_cap'
```

## List content plan

`GET /api/v1/quality/content-plan`

Query:

| Parameter | Rules |
|---|---|
| `view` | optional; default `opportunities`; enum `opportunities|all_interests` |
| `cursor` | optional opaque bounded string; must match view/ranking/generation |
| `limit` | optional integer; default 25, min 1, max 100 |

```ts
interface ContentPlanPage {
  range: '30d'
  window: { from: string; to: string }
  comparisonWindow: { from: string; to: string }
  asOf: string
  projection: ContentPlanProjection
  summary: ContentPlanSummary
  rankingVersion: 1
  recommendedTopicId: string | null
  items: ContentPlanTopicSummary[]
  emerging: ContentPlanEmergingQuestion[]
  nextCursor: string | null
}

interface ContentPlanProjection {
  state: ProjectionState
  processedThrough: string | null
  processingLagSeconds: number | null
  pendingEmbeddingCount: number
  pendingAssignmentCount: number
  pendingEnrichmentTopicCount: number
  processedCount: number | null
  totalCount: number | null
  embeddingSpaceFingerprint: string | null
  reason: string | null
}

interface ContentPlanSummary {
  questionCount: number
  conversationCount: number
  matureTopicCount: number
  emergingQuestionCount: number
  opportunityCount: number
  grounding: {
    evaluatedAnswerCount: number
    groundedAnswerCount: number
    degradedAnswerCount: number
    noSupportAnswerCount: number
    notEvaluatedAnswerCount: number
    reducedOrNoSupportRate: number | null
    headlineState: 'measured' | 'insufficient_measured_turns' | 'unmeasured'
  }
}
```

### Mature topic summary

```ts
interface ContentPlanTopicSummary {
  id: string
  lifecycle: 'mature'
  label: string | null
  description: string | null
  labelState: EnrichmentState
  demand: {
    currentQuestionCount: number
    comparisonQuestionCount: number
    currentConversationCount: number
    comparisonConversationCount: number
    currentShare: number | null
    absoluteChange: number
    trend: TopicTrend
  }
  grounding: {
    groundedAnswerCount: number
    degradedAnswerCount: number
    noSupportAnswerCount: number
    notEvaluatedAnswerCount: number
    evaluatedAnswerCount: number
    reducedOrNoSupportRate: number | null
    headlineState: 'measured' | 'insufficient_measured_turns' | 'unmeasured'
  }
  evidence: {
    strength: EvidenceStrength
    evaluatedConversationCount: number
    activeGapConversationCount: number
  }
  opportunity: {
    credible: boolean
    priorityReasons: Array<
      | 'active_no_support' | 'active_degraded'
      | 'high_demand' | 'new_demand' | 'rising_demand'
    >
  }
  recommendation: {
    action: RecommendationAction | null
    state: EnrichmentState
    rationale: string | null
    suggestedTitle: string | null
    questionsToAnswer: string[]
    suggestedShape: 'guide' | 'faq' | 'reference' | 'policy' | 'troubleshooting' | null
    evidenceStatement: string | null
    factsMustBeVerified: true
  }
  corpusEvidence: {
    state: 'pending' | 'ready' | 'unavailable' | 'stale'
    relatedDocumentCount: number
    actionRuleVersion: 1
  }
  affected: {
    agentCount: number
    channelCount: number
  }
  updatedAt: string
}
```

`recommendedTopicId`, when non-null, always identifies `items[0]` in the default
opportunities view and is derived from the same server ordering. The page may return
fewer than `limit` items after the frozen cursor boundary.

### Emerging question

```ts
interface ContentPlanEmergingQuestion {
  observationId: string
  question: string | null
  sourceAvailable: boolean
  conversationId: string | null
  assistantMessageId: string | null
  questionCount: number
  conversationCount: number
  observedAt: string
  state: 'emerging' | 'awaiting_context' | 'awaiting_embedding'
}
```

Emerging entries have no topic ID, generated label, opportunity priority, content
brief, or content action. `question` is null after source deletion/unavailability.

### Empty and degraded semantics

- No eligible traffic: all counts are zero, `items/emerging=[]`, recommendation null;
  projection may still be ready. The UI must not call this “healthy coverage.”
- No evaluated answers: demand remains; rate is null and headline is `unmeasured`.
- Fewer than five evaluated conversations: raw counts remain; headline is
  `insufficient_measured_turns` and percentage is not the only headline.
- A stale/failed enrichment does not zero or hide topic demand/grounding.

## Get topic detail

`GET /api/v1/quality/content-plan/topics/{topicId}`

Path `topicId` is a UUID.

```ts
interface ContentPlanTopicDetail {
  asOf: string
  window: { from: string; to: string }
  comparisonWindow: { from: string; to: string }
  projection: ContentPlanProjection
  canonicalTopicId: string
  redirectedFromTopicId: string | null
  topic: ContentPlanTopicSummary
  decision: {
    action: RecommendationAction | null
    actionState: 'ready' | 'unavailable' | 'pending' | 'stale'
    reasons: string[]
  }
  representativeQuestions: Array<{
    observationId: string
    question: string | null
    sourceAvailable: boolean
    conversationId: string | null
    userMessageId: string | null
    assistantMessageId: string | null
    observedAt: string
    groundingVerdict: 'grounded' | 'degraded' | 'no_support' | 'not_evaluated'
  }>
  relatedDocuments: Array<{
    id: string
    title: string
    updatedAt: string
    possibleRelevance: number
    evidence: {
      existedBeforeGap: boolean
      retrievedByGapAnswers: boolean
      citedByGapAnswers: boolean
      changedAfterGap: boolean
    }
  }>
  affectedAgents: Array<{ id: string; name: string | null; questionCount: number }>
  affectedChannels: Array<{ channel: string | null; questionCount: number }>
}
```

Representative questions are capped at eight. Related documents are capped at five.
No vectors, chunks, excerpts, prompts, completions, provider data, or raw scoring
features are returned. `possibleRelevance` is supporting evidence, not completeness.

A merged ID returns `200` with the canonical topic and redirect metadata after a
workspace-scoped, cycle-protected resolution. Clients replace the URL with
`canonicalTopicId`. Expired redirects return the ordinary 404.

## List topic member turns

`GET /api/v1/quality/content-plan/topics/{topicId}/turns`

Query:

| Parameter | Rules |
|---|---|
| `window` | optional; default `current`; enum `current|comparison|both` |
| `page` | optional positive integer; default 1 |
| `pageSize` | optional integer; default 25, min 1, max 100 |

The response is the existing `LowQualityTurnsPage` schema. Population is the requested
window’s topic memberships intersected with Quality’s canonical turn population.
One assistant answer appears once even if one user message has overlapping semantic
subqueries assigned to the same topic. Existing question/answer mapping, triage,
verification, deletion handling, and ConversationDrawer inputs are preserved.

Merged IDs resolve as detail does. Foreign/unknown/retired IDs return ordinary 404.

## Cursor contract

The opaque list cursor signs/encodes:

```ts
{
  version: 1
  workspaceId: string
  projectionGenerationId: string
  asOf: string
  view: ContentPlanView
  rankingVersion: 1
  order: {
    activeNoSupportConversationCount: number
    activeDegradedConversationCount: number
    currentConversationCount: number
    trendRank: number
    topicId: string
  }
}
```

The server rejects malformed, foreign-workspace, wrong-view, expired-generation, or
unsupported-version cursors as `400`. Generated label/recommendation changes are not
part of ordering and do not invalidate a cursor.

## Error shapes

Existing error envelopes are reused:

- `400` invalid query/cursor;
- `401` unauthenticated;
- `403` missing `workspace.quality.read`;
- `404` unknown/foreign/retired/expired redirect topic;
- `500` unexpected read failure.

Provider/enrichment failure is represented in the successful read model and is not an
HTTP error when core evidence remains coherent.

## Frontend route/handoff contract

Canonical dashboard routes:

```text
/w/{workspaceKey}/content-plan
/w/{workspaceKey}/content-plan?view=all_interests
/w/{workspaceKey}/content-plan/topics/{topicId}?view=opportunities|all_interests
```

Handoffs carry authorized identifiers only:

```text
/w/{workspaceKey}/quality?contentPlanTopic={topicId}
/w/{workspaceKey}/knowledge/documents/{documentId}?fromContentPlan={topicId}
/w/{workspaceKey}/knowledge?draftFromContentPlan={topicId}
```

The document draft flow fetches the topic detail after navigation and prefills only
the suggested title and question outline. No visitor question, brief, or factual
answer is encoded in the URL.

## OpenAPI, SDK, and MCP alignment

- Runtime schemas: `backend/src/app/http/openapi/schemas/contentPlanningSchemas.ts`
- Runtime paths: `backend/src/app/http/openapi/paths/contentPlanningPaths.ts`
- Generated outputs: `backend/openapi.{json,yaml}`,
  `typescript-sdk/openapi/radioso.{json,yaml}`,
  `typescript-sdk/src/generated/types.ts`, and
  `packages/radioso-mcp-server/src/generated/openapiTypes.ts`
- No MCP tool is added. Generated types include the HTTP operations because the public
  OpenAPI document changes.
- No AMQP/document-worker payload changes.
