'use client'

import { useCallback, useEffect, useState } from 'react'

import { ConversationDrawer } from './conversation-drawer'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { DashboardTable, DashboardTableBody, DashboardTableCell, DashboardTableHead, DashboardTableHeader, DashboardTableRow } from '@/components/dashboard/shared/dashboard-table'
import type { SelectedHistoryItem } from '@/components/dashboard/history/history-list'
import { Skeleton } from '@/components/ui/skeleton'
import { hitlApi } from '@/lib/api-hitl'
import type { PendingApprovalDecision } from '@/lib/api-types'
import type { DashboardRouteState } from '@/lib/dashboard-routes'

interface NeedsAttentionViewProps {
  accountId: string
  routeState: DashboardRouteState
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export const formatApprovalCreatedAt = (createdAt: string, now = new Date()): string => {
  const created = new Date(createdAt)
  if (Number.isNaN(created.getTime())) {
    return createdAt
  }

  const diffSeconds = Math.round((created.getTime() - now.getTime()) / 1000)
  const absSeconds = Math.abs(diffSeconds)
  if (absSeconds < 60) {
    return relativeTimeFormatter.format(diffSeconds, 'second')
  }

  const diffMinutes = Math.round(diffSeconds / 60)
  const absMinutes = Math.abs(diffMinutes)
  if (absMinutes < 60) {
    return relativeTimeFormatter.format(diffMinutes, 'minute')
  }

  const diffHours = Math.round(diffMinutes / 60)
  const absHours = Math.abs(diffHours)
  if (absHours < 24) {
    return relativeTimeFormatter.format(diffHours, 'hour')
  }

  return relativeTimeFormatter.format(Math.round(diffHours / 24), 'day')
}

function PendingApprovalRow({
  decision,
  onSelect,
}: {
  decision: PendingApprovalDecision
  onSelect: (decision: PendingApprovalDecision) => void
}) {
  return (
    <DashboardTableRow>
      <DashboardTableCell>
        <button
          type="button"
          onClick={() => onSelect(decision)}
          className="block max-w-full text-left text-sm font-medium leading-5 text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="block truncate">{decision.reason}</span>
        </button>
      </DashboardTableCell>
      <DashboardTableCell className="w-48 text-sm text-muted-foreground">
        <span className="block truncate">{decision.agentId}</span>
      </DashboardTableCell>
      <DashboardTableCell className="w-40 text-sm text-muted-foreground">
        {formatApprovalCreatedAt(decision.createdAt)}
      </DashboardTableCell>
    </DashboardTableRow>
  )
}

export function NeedsAttentionView({ routeState }: NeedsAttentionViewProps) {
  const [decisions, setDecisions] = useState<PendingApprovalDecision[]>([])
  const [selectedItem, setSelectedItem] = useState<SelectedHistoryItem>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadPendingDecisions = useCallback(async () => {
    try {
      setError(null)
      const response = await hitlApi.listPendingDecisions()
      setDecisions(response.decisions)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load pending approvals.')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        setError(null)
        const response = await hitlApi.listPendingDecisions()
        if (!cancelled) {
          setDecisions(response.decisions)
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Failed to load pending approvals.')
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSelectedItemChange = useCallback((next: SelectedHistoryItem) => {
    setSelectedItem(next)
    if (!next) {
      void loadPendingDecisions()
    }
  }, [loadPendingDecisions])

  const handleDrawerClosed = useCallback(() => {
    setSelectedItem(null)
    void loadPendingDecisions()
  }, [loadPendingDecisions])

  const handleSelectDecision = (decision: PendingApprovalDecision) => {
    setSelectedItem({ kind: 'chat', id: decision.conversationId })
  }

  return (
    <>
      <DashboardPage
        title="Pending approvals"
        description={`${decisions.length} pending approval${decisions.length === 1 ? '' : 's'}`}
      >
        {error ? (
          <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : decisions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
            No approvals are waiting.
          </div>
        ) : (
          <DashboardTable aria-label="Pending approvals" minWidth="min-w-[720px]">
            <DashboardTableHead>
              <DashboardTableHeader>Reason</DashboardTableHeader>
              <DashboardTableHeader className="w-48">Agent</DashboardTableHeader>
              <DashboardTableHeader className="w-40">Created</DashboardTableHeader>
            </DashboardTableHead>
            <DashboardTableBody>
              {decisions.map((decision) => (
                <PendingApprovalRow
                  key={`${decision.agentId}-${decision.handle}`}
                  decision={decision}
                  onSelect={handleSelectDecision}
                />
              ))}
            </DashboardTableBody>
          </DashboardTable>
        )}

        {/* TODO(F4): Add the human-owned-conversations inbox group here. */}
      </DashboardPage>

      <ConversationDrawer
        selectedItem={selectedItem}
        onSelectedItemChange={handleSelectedItemChange}
        anchorMessageId={routeState.historyMessageId}
        onAfterClose={handleDrawerClosed}
      />
    </>
  )
}
