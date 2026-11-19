'use client'

import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { AudiencePulseThemeEvidence } from '@/lib/api-audience-pulse'
import {
  filterTopicRows,
  formatCount,
  formatPoints,
  formatRateOrCount,
  isAboveSampleFloor,
  sortTopicRows,
  topicFilterCounts,
  type OtherTopicRow,
  type TopicComparison,
  type TopicFilter,
  type TopicRow,
  type TopicSort,
  type TopicSortKey,
} from '@/lib/audience-pulse-figures'
import { cn } from '@/lib/utils'

import { NO_ANSWER_FILL } from './answer-split-bar'
import { formatDayMonth } from './pulse-dates'
import { TopicDetail } from './topic-detail'
import { TopicTrend } from './topic-trend'

const ROW_LIMIT = 10

const FILTERS: ReadonlyArray<{ id: TopicFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'content', label: 'Content to write' },
  { id: 'new', label: 'New' },
  { id: 'rising', label: 'Rising' },
]

export const topicRowElementId = (topicId: string) => `audience-pulse-topic-${topicId}`

const NUMBER_CELL = 'px-3 py-2.5 text-right tabular-nums'

function FilterChips({
  counts,
  active,
  onChange,
}: {
  counts: Record<TopicFilter, number>
  active: TopicFilter
  onChange: (filter: TopicFilter) => void
}) {
  return (
    <div role="group" aria-label="Filter topics" className="flex flex-wrap gap-2">
      {FILTERS.map((filter) => {
        const pressed = filter.id === active
        return (
          <button
            key={filter.id}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(filter.id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              pressed ? 'border-foreground bg-foreground text-background' : 'border-border text-foreground hover:bg-muted/60',
            )}
          >
            {filter.label}
            <span className={cn('tabular-nums', pressed ? 'text-background/70' : 'text-muted-foreground')}>
              {counts[filter.id]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function SortHeader({
  sortKey,
  sort,
  onSort,
  children,
}: {
  sortKey: TopicSortKey
  sort: TopicSort
  onSort: (key: TopicSortKey) => void
  children: ReactNode
}) {
  const active = sort.key === sortKey
  const Arrow = sort.direction === 'desc' ? ArrowDown : ArrowUp
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === 'desc' ? 'descending' : 'ascending') : undefined}
      className="px-3 py-2 text-right font-normal"
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn('inline-flex items-center gap-1 hover:text-foreground', active && 'text-foreground')}
      >
        {children}
        {active ? <Arrow className="size-3" aria-hidden /> : null}
      </button>
    </th>
  )
}

function ShareCell({
  questionCount,
  noAnswerCount,
  share,
  largestQuestionCount,
}: {
  questionCount: number
  noAnswerCount: number
  share: number
  largestQuestionCount: number
}) {
  const width = largestQuestionCount > 0 ? (questionCount / largestQuestionCount) * 100 : 0
  const noAnswerWidth = questionCount > 0 ? (noAnswerCount / questionCount) * 100 : 0
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex h-1.5 gap-px overflow-hidden rounded-full" style={{ width: `${Math.min(100, Math.max(width, 2))}%` }}>
              <span className="h-full flex-1 bg-muted-foreground/35" />
              {noAnswerCount > 0 ? (
                <span className={cn('h-full shrink-0', NO_ANSWER_FILL)} style={{ width: `max(2px, ${noAnswerWidth}%)` }} />
              ) : null}
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {formatCount(questionCount)} questions
            {noAnswerCount > 0 ? ` · ${formatCount(noAnswerCount)} with no answer in your content` : ''}
          </TooltipContent>
        </Tooltip>
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{Math.round(share * 100)}%</span>
    </div>
  )
}

const Muted = ({ children }: { children: ReactNode }) => <span className="text-muted-foreground">{children}</span>

function ComparisonCell({ comparison }: { comparison: TopicComparison }) {
  if (comparison.kind === 'new') return <Badge variant="outline" className="rounded-full font-normal">New</Badge>
  if (comparison.kind === 'none') return <Muted>—</Muted>
  return comparison.points === 0 ? <Muted>{formatPoints(0)}</Muted> : <>{formatPoints(comparison.points)}</>
}

function TopicTableRow({
  row,
  largestQuestionCount,
  expanded,
  onToggle,
  onOpenConversation,
  draftControl,
}: {
  row: TopicRow
  largestQuestionCount: number
  expanded: boolean
  onToggle: () => void
  onOpenConversation: (evidence: AudiencePulseThemeEvidence) => void
  draftControl: ReactNode
}) {
  const { theme } = row
  const detailId = `${topicRowElementId(theme.id)}-detail`
  return (
    <>
      <tr id={topicRowElementId(theme.id)} className="border-t border-border" data-testid="audience-pulse-topic-row">
        <td className="py-1.5 pl-2 pr-3">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={onToggle}
            className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm font-medium text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
              aria-hidden
            />
            {theme.title}
          </button>
        </td>
        <td className="px-3 py-2.5">
          <ShareCell
            questionCount={theme.memberCount}
            noAnswerCount={row.noAnswerCount}
            share={theme.share}
            largestQuestionCount={largestQuestionCount}
          />
        </td>
        <td className={NUMBER_CELL}>{formatCount(theme.memberCount)}</td>
        <td className={NUMBER_CELL}><ComparisonCell comparison={row.comparison} /></td>
        <td className="px-3 py-2.5">
          {isAboveSampleFloor(theme.memberCount) ? <TopicTrend title={theme.title} weeks={theme.weeklyPulse} /> : null}
        </td>
        <td className={NUMBER_CELL}>
          {row.answeredCount === null ? <Muted>—</Muted> : formatRateOrCount(row.answeredCount, theme.memberCount)}
        </td>
        <td className={NUMBER_CELL}>
          {row.noAnswerCount === 0 ? <Muted>—</Muted> : formatCount(row.noAnswerCount)}
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={7}>
            <TopicDetail
              id={detailId}
              theme={theme}
              onOpenConversation={onOpenConversation}
              draftControl={draftControl}
            />
          </td>
        </tr>
      ) : null}
    </>
  )
}

function OtherRow({ other, largestQuestionCount }: { other: OtherTopicRow; largestQuestionCount: number }) {
  return (
    <tr className="border-t border-border text-muted-foreground">
      <td className="py-2.5 pl-8 pr-3 text-sm">Other</td>
      <td className="px-3 py-2.5">
        <ShareCell
          questionCount={other.questionCount}
          noAnswerCount={0}
          share={other.share}
          largestQuestionCount={largestQuestionCount}
        />
      </td>
      <td className={NUMBER_CELL}>{formatCount(other.questionCount)}</td>
      <td className={NUMBER_CELL}>—</td>
      <td />
      <td className={NUMBER_CELL}>{formatRateOrCount(other.answeredCount, other.questionCount)}</td>
      <td className={NUMBER_CELL}>{other.noAnswerCount === 0 ? '—' : formatCount(other.noAnswerCount)}</td>
    </tr>
  )
}

export interface TopicsTableState {
  filter: TopicFilter
  showAll: boolean
  expandedTopicId: string | null
}

export function TopicsTable({
  rows,
  other,
  newCount,
  stoppedCount,
  previousGeneratedAt,
  state,
  onStateChange,
  onOpenConversation,
  draftControlFor,
  emptyMessage,
}: {
  emptyMessage: string
  rows: readonly TopicRow[]
  other: OtherTopicRow | null
  newCount: number
  stoppedCount: number
  previousGeneratedAt: string | null
  state: TopicsTableState
  onStateChange: (next: TopicsTableState) => void
  onOpenConversation: (evidence: AudiencePulseThemeEvidence) => void
  draftControlFor: (topicId: string) => ReactNode
}) {
  const [sort, setSort] = useState<TopicSort>({ key: 'questions', direction: 'desc' })
  const visible = sortTopicRows(filterTopicRows(rows, state.filter), sort)
  const shown = state.showAll ? visible : visible.slice(0, ROW_LIMIT)
  const largestQuestionCount = Math.max(0, ...rows.map((row) => row.theme.memberCount))
  const onSort = (key: TopicSortKey) =>
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }))

  const heading = (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 id="audience-pulse-topics" className="text-base font-semibold text-foreground">Topics</h2>
      <span className="text-sm text-muted-foreground">
        {rows.length} {rows.length === 1 ? 'topic' : 'topics'} · {newCount} new · {stoppedCount} stopped appearing
      </span>
    </div>
  )
  if (rows.length === 0) {
    return (
      <section aria-labelledby="audience-pulse-topics" className="space-y-3">
        {heading}
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </section>
    )
  }

  return (
    <section aria-labelledby="audience-pulse-topics" className="space-y-3">
      {heading}
      <FilterChips
        counts={topicFilterCounts(rows)}
        active={state.filter}
        onChange={(filter) => onStateChange({ ...state, filter, showAll: false })}
      />
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-normal">Topic</th>
              <th scope="col" className="px-3 py-2 text-left font-normal">Share</th>
              <SortHeader sortKey="questions" sort={sort} onSort={onSort}>Questions</SortHeader>
              <SortHeader sortKey="comparison" sort={sort} onSort={onSort}>
                {previousGeneratedAt ? `vs ${formatDayMonth(previousGeneratedAt)}` : 'vs previous'}
              </SortHeader>
              <th scope="col" className="px-3 py-2 text-left font-normal">Trend</th>
              <SortHeader sortKey="answered" sort={sort} onSort={onSort}>Answered</SortHeader>
              <SortHeader sortKey="noAnswer" sort={sort} onSort={onSort}>No answer</SortHeader>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <TopicTableRow
                key={row.theme.id}
                row={row}
                largestQuestionCount={largestQuestionCount}
                expanded={state.expandedTopicId === row.theme.id}
                onToggle={() => onStateChange({
                  ...state,
                  expandedTopicId: state.expandedTopicId === row.theme.id ? null : row.theme.id,
                })}
                onOpenConversation={onOpenConversation}
                draftControl={row.inQueue ? draftControlFor(row.theme.id) : null}
              />
            ))}
            {state.filter === 'all' && other ? <OtherRow other={other} largestQuestionCount={largestQuestionCount} /> : null}
          </tbody>
        </table>
      </div>
      {visible.length > ROW_LIMIT ? (
        <Button
          type="button"
          variant="link"
          className="h-auto px-0 text-foreground"
          onClick={() => onStateChange({ ...state, showAll: !state.showAll })}
        >
          {state.showAll ? 'Show fewer' : `Show all ${visible.length}`}
        </Button>
      ) : null}
    </section>
  )
}
