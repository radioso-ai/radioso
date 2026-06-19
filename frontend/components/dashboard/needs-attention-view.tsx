'use client'

import { useCallback, useEffect, useState } from 'react'

import { ConversationDrawer } from './conversation-drawer'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { DashboardTable, DashboardTableBody, DashboardTableCell, DashboardTableHead, DashboardTableHeader, DashboardTableRow } from '@/components/dashboard/shared/dashboard-table'
import type { SelectedHistoryItem } from '@/components/dashboard/history/history-list'
import { Skeleton } from '@/components/ui/skeleton'
import { chatApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { hitlApi } from '@/lib/api-hitl'
import type { ChatConversationSummary, PendingApprovalDecision } from '@/lib/api-types'
import type { DashboardRouteState } from '@/lib/dashboard-routes'
import {
  type HumanOwnedConversationSummary,
  ownershipLabel,
  selectHumanOwnedConversations,
} from '@/lib/needs-attention'

interface NeedsAttentionViewProps {
  accountId: string
  routeState: DashboardRouteState
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const HUMAN_OWNED_CONVERSATION_PAGE_SIZE = 50

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

function HumanOwnedConversationRow({
  conversation,
  onSelect,
}: {
  conversation: HumanOwnedConversationSummary
  onSelect: (conversation: ChatConversationSummary) => void
}) {
  return (
    <DashboardTableRow>
      <DashboardTableCell>
        <button
          type="button"
          onClick={() => onSelect(conversation)}
          className="block max-w-full text-left text-sm font-medium leading-5 text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="block truncate">{conversation.preview || 'Untitled conversation'}</span>
        </button>
      </DashboardTableCell>
      <DashboardTableCell className="w-48 text-sm text-muted-foreground">
        <span className="block truncate">{ownershipLabel(conversation.ownership)}</span>
      </DashboardTableCell>
      <DashboardTableCell className="w-40 text-sm text-muted-foreground">
        {formatApprovalCreatedAt(conversation.updatedAt)}
      </DashboardTableCell>
    </DashboardTableRow>
  )
}

function SectionHeader({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div>
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

export function NeedsAttentionView({ routeState }: NeedsAttentionViewProps) {
  const [decisions, setDecisions] = useState<PendingApprovalDecision[]>([])
  const [humanOwnedConversations, setHumanOwnedConversations] = useState<HumanOwnedConversationSummary[]>([])
  const [selectedItem, setSelectedItem] = useState<SelectedHistoryItem>(null)
  const [isLoadingApprovals, setIsLoadingApprovals] = useState(true)
  const [isLoadingConversations, setIsLoadingConversations] = useState(true)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [conversationError, setConversationError] = useState<string | null>(null)

  const loadPendingDecisions = useCallback(async () => {
    try {
      setApprovalError(null)
      const response = await hitlApi.listPendingDecisions()
      setDecisions(response.decisions)
    } catch (caught) {
      setApprovalError(caught instanceof Error ? caught.message : 'Failed to load pending approvals.')
    } finally {
      setIsLoadingApprovals(false)
    }
  }, [])

  const loadHumanOwnedConversations = useCallback(async () => {
    try {
      setConversationError(null)
      const response = await chatApi.listChatHistory({
        limit: HUMAN_OWNED_CONVERSATION_PAGE_SIZE,
        offset: 0,
      })
      setHumanOwnedConversations(selectHumanOwnedConversations(response.conversations))
    } catch (caught) {
      setConversationError(getApiErrorMessage(caught, 'Failed to load human-owned conversations.'))
      setHumanOwnedConversations([])
    } finally {
      setIsLoadingConversations(false)
    }
  }, [])

  const refreshInbox = useCallback(async () => {
    await Promise.all([
      loadPendingDecisions(),
      loadHumanOwnedConversations(),
    ])
  }, [loadHumanOwnedConversations, loadPendingDecisions])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      const [approvalsResult, conversationsResult] = await Promise.allSettled([
        hitlApi.listPendingDecisions(),
        chatApi.listChatHistory({
          limit: HUMAN_OWNED_CONVERSATION_PAGE_SIZE,
          offset: 0,
        }),
      ])

      if (cancelled) {
        return
      }

      if (approvalsResult.status === 'fulfilled') {
        setDecisions(approvalsResult.value.decisions)
      } else {
        setApprovalError(
          approvalsResult.reason instanceof Error
            ? approvalsResult.reason.message
            : 'Failed to load pending approvals.',
        )
      }

      if (conversationsResult.status === 'fulfilled') {
        setHumanOwnedConversations(selectHumanOwnedConversations(conversationsResult.value.conversations))
      } else {
        setHumanOwnedConversations([])
        setConversationError(getApiErrorMessage(conversationsResult.reason, 'Failed to load human-owned conversations.'))
      }

      setIsLoadingApprovals(false)
      setIsLoadingConversations(false)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSelectedItemChange = useCallback((next: SelectedHistoryItem) => {
    setSelectedItem(next)
    if (!next) {
      void refreshInbox()
    }
  }, [refreshInbox])

  const handleDrawerClosed = useCallback(() => {
    setSelectedItem(null)
    void refreshInbox()
  }, [refreshInbox])

  const handleSelectDecision = (decision: PendingApprovalDecision) => {
    setSelectedItem({ kind: 'chat', id: decision.conversationId })
  }

  const handleSelectHumanOwnedConversation = (conversation: ChatConversationSummary) => {
    setSelectedItem({ kind: 'chat', id: conversation.id })
  }

  const needsAttentionCount = decisions.length + humanOwnedConversations.length
  const isLoading = isLoadingApprovals || isLoadingConversations
  const showEmptyState =
    !isLoading &&
    !approvalError &&
    !conversationError &&
    decisions.length === 0 &&
    humanOwnedConversations.length === 0
  const showApprovalsSection = isLoadingApprovals || approvalError || decisions.length > 0
  const showHumanOwnedSection = isLoadingConversations || conversationError || humanOwnedConversations.length > 0

  return (
    <>
      <DashboardPage
        title="Needs attention"
        description={`${needsAttentionCount} item${needsAttentionCount === 1 ? '' : 's'} needing operator attention`}
      >
        <div className="space-y-8">
          {showApprovalsSection ? (
            <section className="space-y-3">
              <SectionHeader
                title="Pending approvals"
                description={`${decisions.length} pending approval${decisions.length === 1 ? '' : 's'}`}
              />

              {approvalError ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                  {approvalError}
                </div>
              ) : null}

              {isLoadingApprovals ? (
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
            </section>
          ) : null}

          {showHumanOwnedSection ? (
            <section className="space-y-3">
              <SectionHeader
                title="Awaiting / handled by a human"
                description={`${humanOwnedConversations.length} human-owned conversation${humanOwnedConversations.length === 1 ? '' : 's'}`}
              />

              {conversationError ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                  {conversationError}
                </div>
              ) : null}

              {isLoadingConversations ? (
                <div className="space-y-3">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : humanOwnedConversations.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                  No human-owned conversations need attention.
                </div>
              ) : (
                <DashboardTable aria-label="Awaiting / handled by a human" minWidth="min-w-[640px]">
                  <DashboardTableHead>
                    <DashboardTableHeader>Conversation</DashboardTableHeader>
                    <DashboardTableHeader className="w-48">Owner</DashboardTableHeader>
                    <DashboardTableHeader className="w-40">Updated</DashboardTableHeader>
                  </DashboardTableHead>
                  <DashboardTableBody>
                    {humanOwnedConversations.map((conversation) => (
                      <HumanOwnedConversationRow
                        key={conversation.id}
                        conversation={conversation}
                        onSelect={handleSelectHumanOwnedConversation}
                      />
                    ))}
                  </DashboardTableBody>
                </DashboardTable>
              )}
            </section>
          ) : null}

          {showEmptyState ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
              Nothing needs attention.
            </div>
          ) : null}
        </div>
      </DashboardPage>

      <ConversationDrawer
        selectedItem={selectedItem}
        onSelectedItemChange={handleSelectedItemChange}
        anchorMessageId={routeState.historyMessageId}
        onAfterClose={handleDrawerClosed}
        onOperatorChanged={refreshInbox}
      />
    </>
  )
}
