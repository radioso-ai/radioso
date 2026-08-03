'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { ConversationDrawer } from './conversation-drawer'
import {
  HistoryList,
} from '@/components/dashboard/history/history-list'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import {
  clearAudiencePulseEvidenceHandoff,
  consumeAudiencePulseEvidenceHandoff,
  type AudiencePulseEvidenceHandoff,
} from '@/lib/audience-pulse-evidence-handoff'
import {
  HISTORY_PAGE_SIZE,
  useHistoryListState,
} from '@/components/dashboard/history/use-chat-history-state'

export function ChatHistoryView({
  accountId,
  onboarding,
  routeState,
}: {
  accountId: string
  onboarding: WorkspaceOnboardingState
  routeState: DashboardRouteState
}) {
  const {
    filter,
    isListLoading,
    hasAnyHistory,
    listError,
    conversations: conversationPageItems,
    conversationTotal,
    conversationPage,
    conversationTotalPages,
    searches: searchPageItems,
    searchTotal,
    searchPage,
    searchTotalPages,
    contacts: contactPageItems,
    contactTotal,
    contactPage,
    contactTotalPages,
    allHistoryItems,
    allTotal,
    allPage,
    allTotalPages,
    selectedItem,
    setSelectedItem,
    pushHistoryRoute,
    onFilterChange,
    onSelectItem,
    onConversationPageChange,
    onSearchPageChange,
    onContactPageChange,
    onAllPageChange,
    onNavigate,
  } = useHistoryListState({ accountId, routeState })
  const evidenceHandoffRef = useRef<{
    scope: string | null
    handoff: AudiencePulseEvidenceHandoff | null | undefined
    delivered: boolean
  }>({ scope: null, handoff: undefined, delivered: false })
  const [audiencePulseEvidence, setAudiencePulseEvidence] = useState<AudiencePulseEvidenceHandoff | null>(null)

  useEffect(() => {
    const workspaceId = routeState.workspaceId
    if (!workspaceId || (routeState.historyItemKind && routeState.historyItemId)) {
      clearAudiencePulseEvidenceHandoff()
      evidenceHandoffRef.current = {
        scope: workspaceId ? `${accountId}:${workspaceId}` : null,
        handoff: null,
        delivered: true,
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- An explicit Activity URL must supersede a transient Audience Pulse selection.
      setAudiencePulseEvidence(null)
      return
    }

    const scope = `${accountId}:${workspaceId}`
    if (evidenceHandoffRef.current.scope !== scope) {
      evidenceHandoffRef.current = { scope, handoff: undefined, delivered: false }
    }
    if (evidenceHandoffRef.current.handoff === undefined) {
      evidenceHandoffRef.current.handoff = consumeAudiencePulseEvidenceHandoff({ accountId, workspaceId })
    }

    const handoff = evidenceHandoffRef.current.handoff
    if (!handoff) {
      setAudiencePulseEvidence(null)
      return
    }
    if (evidenceHandoffRef.current.delivered) {
      return
    }
    if (selectedItem?.kind === 'chat' && selectedItem.id === handoff.conversationId) {
      evidenceHandoffRef.current.delivered = true
      return
    }

    setAudiencePulseEvidence(handoff)
    setSelectedItem({ kind: 'chat', id: handoff.conversationId })
  }, [
    accountId,
    routeState.historyItemId,
    routeState.historyItemKind,
    routeState.workspaceId,
    selectedItem,
    setSelectedItem,
  ])

  const handleDrawerClosed = useCallback(() => {
    setAudiencePulseEvidence(null)
    pushHistoryRoute({ selectedItem: null })
  }, [pushHistoryRoute])

  const handleSelectItem = useCallback((item: Parameters<typeof onSelectItem>[0]) => {
    setAudiencePulseEvidence(null)
    onSelectItem(item)
  }, [onSelectItem])

  const buildRoutineHref = useCallback(
    (agentId: string, routineId: string) =>
      buildDashboardHref(accountId, {
        ...routeState,
        section: 'agents',
        agentId,
        agentRoutineId: routineId,
        agentTab: undefined,
        anchor: undefined,
      }),
    [accountId, routeState],
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <HistoryList
        accountId={accountId}
        workspaceId={routeState.workspaceId}
        routeState={routeState}
        onboarding={onboarding}
        filter={filter}
        isLoading={isListLoading}
        hasAnyHistory={hasAnyHistory}
        listError={listError}
        pageSize={HISTORY_PAGE_SIZE}
        conversations={conversationPageItems}
        conversationTotal={conversationTotal}
        conversationPage={conversationPage}
        conversationTotalPages={conversationTotalPages}
        searches={searchPageItems}
        searchTotal={searchTotal}
        searchPage={searchPage}
        searchTotalPages={searchTotalPages}
        contacts={contactPageItems}
        contactTotal={contactTotal}
        contactPage={contactPage}
        contactTotalPages={contactTotalPages}
        allHistoryItems={allHistoryItems}
        allTotal={allTotal}
        allPage={allPage}
        allTotalPages={allTotalPages}
        onFilterChange={onFilterChange}
        onSelectItem={handleSelectItem}
        onConversationPageChange={onConversationPageChange}
        onSearchPageChange={onSearchPageChange}
        onContactPageChange={onContactPageChange}
        onAllPageChange={onAllPageChange}
        onNavigate={onNavigate}
      />

      <ConversationDrawer
        selectedItem={selectedItem}
        onSelectedItemChange={setSelectedItem}
        anchorMessageId={
          audiencePulseEvidence && audiencePulseEvidence.conversationId === selectedItem?.id
            ? audiencePulseEvidence.messageId
            : routeState.historyMessageId
        }
        isAudiencePulseEvidence={
          Boolean(audiencePulseEvidence && audiencePulseEvidence.conversationId === selectedItem?.id)
        }
        onAfterClose={handleDrawerClosed}
        buildRoutineHref={buildRoutineHref}
      />
    </div>
  )
}
