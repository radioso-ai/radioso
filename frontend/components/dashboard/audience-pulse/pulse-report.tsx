'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Info } from 'lucide-react'

import { UndoToast } from '@/components/dashboard/shared/undo-toast'
import type { AudiencePulseHydratedReport, AudiencePulseThemeEvidence } from '@/lib/api-audience-pulse'
import type { AudiencePulseDraftSeed } from '@/lib/audience-pulse-draft-seed'
import {
  answerSplit,
  channelRows,
  formatCount,
  otherTopicRow,
  pulseTiles,
  topicRows,
} from '@/lib/audience-pulse-figures'
import { contentQueue, type ContentQueueItem } from '@/lib/audience-pulse-queue'
import { useWorkspaceCanManage } from '@/lib/use-workspace-can-manage'

import { AnswerSplitSummary } from './answer-split-bar'
import { ChannelsSection } from './channels-section'
import { ContentQueueSection } from './content-queue-section'
import { DraftControl } from './draft-control'
import { formatDay } from './pulse-dates'
import { PulseTiles } from './pulse-tiles'
import { topicRowElementId, TopicsTable, type TopicsTableState } from './topics-table'
import { useTopicDismissals } from './use-topic-dismissals'

interface Toast {
  id: number
  message: string
  onUndo?: () => void
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm text-muted-foreground">
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>{children}</p>
    </div>
  )
}

function CoverageNotices({ report, awaitingTopicAnalysis }: {
  report: AudiencePulseHydratedReport
  awaitingTopicAnalysis: boolean
}) {
  const { sampled, sampleSize, populationSize, facetReadyQuestionCount } = report.coverage
  const partiallyAnalysed = !sampled && facetReadyQuestionCount > 0 && facetReadyQuestionCount < populationSize
  const unclassifiedDenominator = sampled ? sampleSize : populationSize
  const mostlyUngrouped = !awaitingTopicAnalysis
    && !partiallyAnalysed
    && report.unclassifiedQuestionCount > unclassifiedDenominator / 2
  return (
    <>
      {sampled ? (
        <Notice>
          Read {formatCount(sampleSize)} of {formatCount(populationSize)} questions. Counts reflect the questions
          we read, not total demand.
        </Notice>
      ) : null}
      {partiallyAnalysed ? (
        <Notice>
          {formatCount(facetReadyQuestionCount)} of {formatCount(populationSize)} questions have been processed so
          far, so topics below cover part of this period.
        </Notice>
      ) : null}
      {mostlyUngrouped ? (
        <Notice>
          Most questions weren&apos;t grouped into a topic ({formatCount(report.unclassifiedQuestionCount)} of{' '}
          {formatCount(unclassifiedDenominator)}).
        </Notice>
      ) : null}
    </>
  )
}

function Footer({ report }: { report: AudiencePulseHydratedReport }) {
  if (report.dissolvedTopics.length === 0 && report.caveats.length === 0) return null
  return (
    <footer className="space-y-3 border-t border-border pt-5 text-sm text-muted-foreground">
      {report.dissolvedTopics.length > 0 ? (
        <p>Stopped appearing: {report.dissolvedTopics.map((topic) => topic.title).join(', ')}</p>
      ) : null}
      {report.caveats.length > 0 ? (
        <details>
          <summary className="cursor-pointer font-medium text-foreground">How this is counted</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {report.caveats.map((caveat, index) => <li key={`caveat-${index}`}>{caveat}</li>)}
          </ul>
        </details>
      ) : null}
    </footer>
  )
}

/** A saved report: summary, headline tiles, how questions were answered, topics, channels, and what to write. */
export function PulseReport({
  report,
  onOpenConversation,
  onStartDraft,
  canStartDraft,
}: {
  report: AudiencePulseHydratedReport
  onOpenConversation: (evidence: AudiencePulseThemeEvidence) => void
  onStartDraft: (seed: AudiencePulseDraftSeed) => void
  canStartDraft: boolean
}) {
  const { canManage } = useWorkspaceCanManage()
  const [toast, setToast] = useState<Toast | null>(null)
  const closeToast = useCallback(() => setToast(null), [])
  const showToast = useCallback((message: string, onUndo?: () => void) => {
    setToast({ id: Date.now(), message, onUndo })
  }, [])
  const onSaveFailed = useCallback(() => showToast('Couldn’t save that. Try again.'), [showToast])
  const { choices, choose } = useTopicDismissals(onSaveFailed)
  const [tableState, setTableState] = useState<TopicsTableState>({
    filter: 'all',
    showAll: false,
    expandedTopicId: null,
  })

  const queue = useMemo(() => contentQueue(report, choices), [report, choices])
  const queueByTopic = useMemo(() => new Map(queue.items.map((item) => [item.topicId, item])), [queue])
  const rows = useMemo(() => topicRows(report, new Set(queueByTopic.keys())), [report, queueByTopic])
  const tiles = useMemo(() => pulseTiles(report), [report])
  const channels = useMemo(() => channelRows(report), [report])
  const totals = report.totals

  // Nothing in this window has been prepared for topic analysis yet — historical questions that
  // predate extraction, or a backfill still draining. Saying "no recurring themes" here would
  // describe the audience when the truth is that nothing has been computed.
  const awaitingTopicAnalysis = report.coverage.populationSize > 0 && report.coverage.facetReadyQuestionCount === 0
  const summary = awaitingTopicAnalysis
    ? 'Topic analysis is still being prepared for this period. Topics appear once its questions have been processed.'
    : report.summary

  const draftControl = (item: ContentQueueItem) => (
    <DraftControl
      item={item}
      onDraft={(target) => onStartDraft(target.draftSeed)}
      canDraft={canStartDraft && canManage}
    />
  )
  const dismiss = (item: ContentQueueItem) => {
    choose(item.topicId, true)
    showToast(`“${item.title}” marked not for us`, () => choose(item.topicId, false))
  }
  const restoreAll = () => {
    for (const topicId of queue.dismissedTopicIds) choose(topicId, false)
  }
  const revealTopic = (topicId: string) => {
    setTableState({ filter: 'all', showAll: true, expandedTopicId: topicId })
    window.requestAnimationFrame(() => {
      document.getElementById(topicRowElementId(topicId))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }

  return (
    <div className="flex flex-col gap-10">
      <div className="space-y-6">
        <div className="space-y-2">
          {summary ? <p className="max-w-3xl text-lg leading-relaxed text-foreground">{summary}</p> : null}
          {report.narrativeReuseCount > 0 ? (
            <p className="text-xs text-muted-foreground">Wording unchanged since {formatDay(report.narrativeGeneratedAt)}.</p>
          ) : null}
        </div>
        <CoverageNotices report={report} awaitingTopicAnalysis={awaitingTopicAnalysis} />
        {tiles ? <PulseTiles tiles={tiles} /> : null}
        {totals ? (
          <AnswerSplitSummary
            parts={answerSplit(totals.answers, totals.contentGapEligibleCount)}
            total={totals.questionCount}
          />
        ) : null}
      </div>

      <TopicsTable
        rows={rows}
        other={otherTopicRow(report)}
        newCount={rows.filter((row) => row.comparison.kind === 'new').length}
        stoppedCount={report.dissolvedTopics.length}
        previousGeneratedAt={report.previousGeneratedAt ?? null}
        state={tableState}
        onStateChange={setTableState}
        onOpenConversation={onOpenConversation}
        draftControlFor={(topicId) => {
          const item = queueByTopic.get(topicId)
          return item ? draftControl(item) : null
        }}
        emptyMessage={awaitingTopicAnalysis
          ? 'Topics appear here once the questions in this period have been processed.'
          : 'No recurring topics in this period.'}
      />

      {channels ? <ChannelsSection rows={channels.rows} overallAnsweredPercent={channels.overallAnsweredPercent} /> : null}

      <ContentQueueSection
        queue={queue}
        totalNoAnswerCount={totals?.contentGapEligibleCount ?? null}
        canDismiss={canManage}
        draftControlFor={draftControl}
        onDismiss={dismiss}
        onRestoreAll={restoreAll}
        onRevealTopic={revealTopic}
      />

      <Footer report={report} />

      {toast ? (
        <UndoToast key={toast.id} message={toast.message} onUndo={toast.onUndo} onClose={closeToast} />
      ) : null}
    </div>
  )
}
