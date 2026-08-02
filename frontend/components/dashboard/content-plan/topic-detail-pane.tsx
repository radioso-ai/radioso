'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  MessageSquareText,
  Sparkles,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  AddDocumentMenu,
  type AddDocumentAction,
} from '@/components/dashboard/documents/add-document-menu'
import type {
  ContentPlanProjection,
  ContentPlanRepresentativeGroundingVerdict,
  ContentPlanTopicDetail,
} from '@/lib/api-content-plan'
import {
  enrichmentStateLabel,
  evidenceSampleSentence,
  formatAsOfTimestamp,
  formatWindowRange,
  headlineStateAnnotation,
  priorityReasonLabel,
  projectionStateExplanation,
  projectionStateLabel,
  recommendationActionExplanation,
  recommendationActionLabel,
  hasCopyableContentPlanBrief,
} from '@/lib/content-plan'
import { cn } from '@/lib/utils'
import { GroundingComposition } from './grounding-composition'

interface TopicDetailPaneProps {
  detail: ContentPlanTopicDetail
  backHref?: string
  onBack?: () => void
  onOpenConversation: (input: { conversationId: string; assistantMessageId: string | null }) => void
  onViewAnswers: () => void
  onWriteDocument: () => void
  websiteCrawlerEnabled: boolean
  onAddDocument: (action: AddDocumentAction) => void
  onReviewDocument: (documentId: string) => void
  onInvestigateRetrieval: () => void
  copyStatus?: 'idle' | 'copied' | 'error'
  onCopyBrief: () => void
  isNarrow?: boolean
}

const VERDICT_LABEL: Record<ContentPlanRepresentativeGroundingVerdict, string> = {
  grounded: 'Grounded',
  degraded: 'Degraded',
  no_support: 'No support',
  not_evaluated: 'Not evaluated',
}

const VERDICT_TONE: Record<ContentPlanRepresentativeGroundingVerdict, string> = {
  grounded: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  degraded: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  no_support: 'border-destructive/40 bg-destructive/10 text-destructive',
  not_evaluated: 'border-border bg-muted text-muted-foreground',
}

export function TopicDetailPane({
  detail,
  backHref,
  onBack,
  onOpenConversation,
  onViewAnswers,
  onWriteDocument,
  websiteCrawlerEnabled,
  onAddDocument,
  onReviewDocument,
  onInvestigateRetrieval,
  copyStatus = 'idle',
  onCopyBrief,
  isNarrow,
}: TopicDetailPaneProps) {
  const { topic, decision } = detail
  const label = topic.label ?? 'Awaiting label'
  const copyBriefAvailable = hasCopyableContentPlanBrief(topic.recommendation)
  const headingRef = useRef<HTMLHeadingElement | null>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [detail.canonicalTopicId])

  return (
    <article
      aria-labelledby="content-plan-topic-heading"
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <header className="shrink-0 border-b border-border bg-background/95 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            {isNarrow && (backHref || onBack) ? (
              <div className="md:hidden">
                {backHref ? (
                  <Button asChild variant="ghost" size="sm">
                    <Link href={backHref}>
                      <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
                      Back to Content plan
                    </Link>
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={onBack}>
                    <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
                    Back to Content plan
                  </Button>
                )}
              </div>
            ) : null}
            <p className={cn(
              'text-xs uppercase tracking-normal text-muted-foreground',
              isNarrow && 'hidden md:block',
            )}>
              Topic detail
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            As of {formatAsOfTimestamp(detail.asOf)}
          </p>
        </div>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2
              id="content-plan-topic-heading"
              ref={headingRef}
              tabIndex={-1}
              className="text-xl font-semibold text-foreground focus-visible:outline-none"
            >
              {label}
            </h2>
            {topic.description ? (
              <p className="mt-1 text-sm text-muted-foreground">{topic.description}</p>
            ) : null}
          </div>
          <Badge variant="outline" className="border-border">
            Label {enrichmentStateLabel(topic.labelState).toLowerCase()}
          </Badge>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Current window: {formatWindowRange(detail.window.from, detail.window.to)} · compared with{' '}
          {formatWindowRange(detail.comparisonWindow.from, detail.comparisonWindow.to)}
        </p>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="space-y-6 p-4">
          <section aria-labelledby="content-plan-topic-decision">
            <h3 id="content-plan-topic-decision" className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
              Decision
            </h3>
            <p className="mt-1 text-sm text-foreground">
              {recommendationActionLabel(decision.action)} —{' '}
              <span className="text-muted-foreground">
                {decisionActionStateLabel(decision.actionState)}
              </span>
            </p>
            {topic.recommendation.state !== 'ready' ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Brief {enrichmentStateLabel(topic.recommendation.state).toLowerCase()}.
              </p>
            ) : null}
            <p className="mt-1 text-sm text-muted-foreground">
              {recommendationActionExplanation(decision.action)}
            </p>
            {decision.reasons.length > 0 ? (
              <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
                {decision.reasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <DecisionActions
                action={decision.action}
                actionState={decision.actionState}
                onWriteDocument={onWriteDocument}
                websiteCrawlerEnabled={websiteCrawlerEnabled}
                onAddDocument={onAddDocument}
                onInvestigateRetrieval={onInvestigateRetrieval}
                onReviewFirstDocument={
                  detail.relatedDocuments.length > 0
                    ? () => onReviewDocument(detail.relatedDocuments[0].id)
                    : undefined
                }
              />
              <Button type="button" variant="outline" size="sm" onClick={onViewAnswers}>
                View answers in Quality
              </Button>
              {copyBriefAvailable ? (
                <>
                  <Button type="button" variant="ghost" size="sm" onClick={onCopyBrief}>
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                    Copy brief
                  </Button>
                  {copyStatus !== 'idle' ? (
                    <span role="status" aria-live="polite" className={cn(
                      'text-xs',
                      copyStatus === 'error' ? 'text-destructive' : 'text-muted-foreground',
                    )}>
                      {copyStatus === 'copied' ? 'Brief copied.' : 'Could not copy the brief.'}
                    </span>
                  ) : null}
                </>
              ) : null}
            </div>
          </section>

          <Separator />

          <section aria-labelledby="content-plan-topic-evidence" className="space-y-3">
            <h3
              id="content-plan-topic-evidence"
              className="text-xs font-medium uppercase tracking-normal text-muted-foreground"
            >
              Evidence and freshness
            </h3>
            <DetailProjectionFreshness projection={detail.projection} />
            <dl className="grid gap-3 sm:grid-cols-3">
              <MetricBlock
                term="Demand"
                value={`${topic.demand.currentQuestionCount} questions`}
                sub={`${topic.demand.currentConversationCount} conversations · ${topic.demand.comparisonQuestionCount} in previous window`}
              />
              <MetricBlock
                term="Grounding"
                value={
                  topic.grounding.headlineState === 'measured'
                    ? `${topic.grounding.degradedAnswerCount + topic.grounding.noSupportAnswerCount} of ${topic.grounding.evaluatedAnswerCount} reduced or no support`
                    : `${topic.grounding.degradedAnswerCount + topic.grounding.noSupportAnswerCount}/${topic.grounding.evaluatedAnswerCount} · ${headlineStateAnnotation(topic.grounding.headlineState).toLowerCase()}`
                }
                sub={evidenceSampleSentence(topic.evidence.evaluatedConversationCount, topic.evidence.strength)}
              />
              <MetricBlock
                term="Coverage state"
                value={topic.opportunity.credible ? 'Credible opportunity' : 'Monitored'}
                sub={
                  topic.opportunity.priorityReasons.length > 0
                    ? topic.opportunity.priorityReasons.map(priorityReasonLabel).join(' · ')
                    : 'No credible active gap right now.'
                }
              />
            </dl>
            <GroundingComposition
              grounding={topic.grounding}
              strength={topic.evidence.strength}
              evaluatedConversationCount={topic.evidence.evaluatedConversationCount}
            />
          </section>

          <Separator />

          <ContentBrief topic={topic} />

          {topic.recommendation.questionsToAnswer.length > 0 ? (
            <section aria-labelledby="content-plan-topic-questions">
              <h3
                id="content-plan-topic-questions"
                className="text-xs font-medium uppercase tracking-normal text-muted-foreground"
              >
                Questions the content should answer
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-foreground">
                {topic.recommendation.questionsToAnswer.map((question, index) => (
                  <li key={index} className="flex gap-2">
                    <span aria-hidden className="mt-0.5 text-muted-foreground">•</span>
                    <span>{question}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <RepresentativeQuestions
            representativeQuestions={detail.representativeQuestions}
            onOpenConversation={onOpenConversation}
          />

          <RelatedDocuments
            relatedDocuments={detail.relatedDocuments}
            onReviewDocument={onReviewDocument}
          />

          <AffectedSurfaces
            affectedAgents={detail.affectedAgents}
            affectedChannels={detail.affectedChannels}
          />

          <p className="text-xs text-muted-foreground">
            Content plan does not invent facts. Verify every fact against a workspace-approved
            source before publishing. Recommendations do not change assistant behavior.
          </p>
        </div>
      </div>
    </article>
  )
}

function DetailProjectionFreshness({ projection }: { projection: ContentPlanProjection }) {
  const pendingCount = projection.pendingEmbeddingCount
    + projection.pendingAssignmentCount
    + projection.pendingEnrichmentTopicCount
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3 text-sm" role="status">
      <p className="font-medium text-foreground">
        {projectionStateLabel(projection.state)}
        {' · '}
        {projection.processedThrough
          ? `processed through ${formatAsOfTimestamp(projection.processedThrough)}`
          : 'no processed-through time yet'}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {projectionStateExplanation(projection.state)}
      </p>
      {(pendingCount > 0 || (projection.processedCount !== null && projection.totalCount !== null)) ? (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {projection.pendingEmbeddingCount > 0 ? (
            <li>{projection.pendingEmbeddingCount} awaiting embedding</li>
          ) : null}
          {projection.pendingAssignmentCount > 0 ? (
            <li>{projection.pendingAssignmentCount} awaiting topic assignment</li>
          ) : null}
          {projection.pendingEnrichmentTopicCount > 0 ? (
            <li>{projection.pendingEnrichmentTopicCount} topics enriching</li>
          ) : null}
          {projection.processedCount !== null && projection.totalCount !== null ? (
            <li>{projection.processedCount} / {projection.totalCount} processed</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

function ContentBrief({ topic }: { topic: ContentPlanTopicDetail['topic'] }) {
  const recommendation = topic.recommendation
  const available = hasCopyableContentPlanBrief(recommendation)
  return (
    <section aria-labelledby="content-plan-topic-brief">
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="content-plan-topic-brief"
          className="text-xs font-medium uppercase tracking-normal text-muted-foreground"
        >
          Content brief
        </h3>
        <Badge variant="outline" className="border-border">
          {enrichmentStateLabel(recommendation.state)}
        </Badge>
      </div>
      {available ? (
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <MetricBlock term="Suggested title" value={recommendation.suggestedTitle!} sub="Working title; review before publishing." />
          <MetricBlock term="Suggested shape" value={recommendation.suggestedShape!} sub="A format suggestion, not a publishing action." />
          <MetricBlock term="Why now" value={recommendation.rationale!} sub="Generated from the evidence shown above." />
          <MetricBlock term="Evidence statement" value={recommendation.evidenceStatement!} sub="Verify against the measured counts above." />
        </dl>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          The generated brief is {enrichmentStateLabel(recommendation.state).toLowerCase()}.
          Demand and grounding evidence remain available above.
        </p>
      )}
    </section>
  )
}

function decisionActionStateLabel(
  state: ContentPlanTopicDetail['decision']['actionState'],
): string {
  switch (state) {
    case 'ready':
      return 'action ready'
    case 'pending':
      return 'action pending'
    case 'stale':
      return 'action being refreshed'
    case 'unavailable':
      return 'action unavailable'
  }
}

function MetricBlock({ term, value, sub }: { term: string; value: string; sub: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-normal text-muted-foreground">{term}</dt>
      <dd className="mt-0.5 text-sm font-medium text-foreground">{value}</dd>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </div>
  )
}

function DecisionActions({
  action,
  actionState,
  onWriteDocument,
  websiteCrawlerEnabled,
  onAddDocument,
  onInvestigateRetrieval,
  onReviewFirstDocument,
}: {
  action: ContentPlanTopicDetail['decision']['action']
  actionState: ContentPlanTopicDetail['decision']['actionState']
  onWriteDocument: () => void
  websiteCrawlerEnabled: boolean
  onAddDocument: (action: AddDocumentAction) => void
  onInvestigateRetrieval: () => void
  onReviewFirstDocument?: () => void
}) {
  if (actionState !== 'ready' || action === null || action === 'monitor') {
    return null
  }
  if (action === 'add_content') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={onWriteDocument}>
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          Write document
        </Button>
        <AddDocumentMenu
          websiteCrawlerEnabled={websiteCrawlerEnabled}
          onSelect={onAddDocument}
          compact
        />
      </div>
    )
  }
  if (action === 'review_existing_content' && onReviewFirstDocument) {
    return (
      <Button type="button" size="sm" onClick={onReviewFirstDocument}>
        Review document
      </Button>
    )
  }
  if (action === 'investigate_retrieval') {
    return (
      <Button type="button" size="sm" onClick={onInvestigateRetrieval}>
        Investigate retrieval
      </Button>
    )
  }
  return null
}

function RepresentativeQuestions({
  representativeQuestions,
  onOpenConversation,
}: {
  representativeQuestions: ContentPlanTopicDetail['representativeQuestions']
  onOpenConversation: (input: { conversationId: string; assistantMessageId: string | null }) => void
}) {
  if (representativeQuestions.length === 0) {
    return null
  }
  return (
    <section aria-labelledby="content-plan-topic-representative">
      <h3
        id="content-plan-topic-representative"
        className="text-xs font-medium uppercase tracking-normal text-muted-foreground"
      >
        Representative visitor questions
      </h3>
      <ul className="mt-2 space-y-2">
        {representativeQuestions.map((item) => (
          <li
            key={item.observationId}
            className="rounded-md border border-border p-3 text-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <p className={cn('flex-1', !item.sourceAvailable ? 'italic text-muted-foreground' : 'text-foreground')}>
                {item.sourceAvailable && item.question
                  ? item.question
                  : 'This message was removed from the workspace.'}
              </p>
              <Badge
                variant="outline"
                className={cn(VERDICT_TONE[item.groundingVerdict])}
              >
                {VERDICT_LABEL[item.groundingVerdict]}
              </Badge>
            </div>
            {item.sourceAvailable && item.conversationId && item.assistantMessageId ? (
              <div className="mt-2">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() =>
                    onOpenConversation({
                      conversationId: item.conversationId!,
                      assistantMessageId: item.assistantMessageId,
                    })
                  }
                >
                  <MessageSquareText className="mr-1 h-3.5 w-3.5" aria-hidden />
                  Open source conversation
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function RelatedDocuments({
  relatedDocuments,
  onReviewDocument,
}: {
  relatedDocuments: ContentPlanTopicDetail['relatedDocuments']
  onReviewDocument: (documentId: string) => void
}) {
  if (relatedDocuments.length === 0) {
    return null
  }
  return (
    <section aria-labelledby="content-plan-topic-related-documents">
      <h3
        id="content-plan-topic-related-documents"
        className="text-xs font-medium uppercase tracking-normal text-muted-foreground"
      >
        Related documents ({relatedDocuments.length})
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Semantic similarity is possible relevance, not proof of completeness or retrieval correctness.
      </p>
      <ul className="mt-2 space-y-2">
        {relatedDocuments.map((doc) => (
          <li
            key={doc.id}
            className="flex items-start justify-between gap-3 rounded-md border border-border p-3 text-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{doc.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Updated {formatAsOfTimestamp(doc.updatedAt)}
                {' · '}
                {doc.evidence.existedBeforeGap ? 'existed before the gap' : 'added recently'}
                {doc.evidence.retrievedByGapAnswers ? ' · retrieved by gap answers' : ''}
                {doc.evidence.citedByGapAnswers ? ' · cited by gap answers' : ''}
                {doc.evidence.changedAfterGap ? ' · changed after the gap' : ''}
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => onReviewDocument(doc.id)}>
              Review
              <ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function AffectedSurfaces({
  affectedAgents,
  affectedChannels,
}: {
  affectedAgents: ContentPlanTopicDetail['affectedAgents']
  affectedChannels: ContentPlanTopicDetail['affectedChannels']
}) {
  if (affectedAgents.length === 0 && affectedChannels.length === 0) {
    return null
  }
  return (
    <section aria-labelledby="content-plan-topic-surfaces">
      <h3
        id="content-plan-topic-surfaces"
        className="text-xs font-medium uppercase tracking-normal text-muted-foreground"
      >
        Affected agents and channels
      </h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {affectedAgents.length > 0 ? (
          <div>
            <p className="text-xs text-muted-foreground">Agents</p>
            <ul className="mt-1 space-y-1 text-sm text-foreground">
              {affectedAgents.map((agent) => (
                <li key={agent.id} className="flex justify-between gap-2">
                  <span className="truncate">{agent.name ?? 'Unnamed agent'}</span>
                  <span className="tabular-nums text-muted-foreground">{agent.questionCount}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {affectedChannels.length > 0 ? (
          <div>
            <p className="text-xs text-muted-foreground">Channels</p>
            <ul className="mt-1 space-y-1 text-sm text-foreground">
              {affectedChannels.map((channel, index) => (
                <li key={index} className="flex justify-between gap-2">
                  <span className="truncate">{channel.channel ?? 'Dashboard chat'}</span>
                  <span className="tabular-nums text-muted-foreground">{channel.questionCount}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  )
}
