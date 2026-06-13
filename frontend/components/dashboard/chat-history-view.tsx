'use client'

import { useCallback } from 'react'

import { ConversationDrawer } from './conversation-drawer'
import {
  HistoryList,
} from '@/components/dashboard/history/history-list'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
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

  const handleDrawerClosed = useCallback(() => {
    pushHistoryRoute({ selectedItem: null })
  }, [pushHistoryRoute])

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
        onSelectItem={onSelectItem}
        onConversationPageChange={onConversationPageChange}
        onSearchPageChange={onSearchPageChange}
        onContactPageChange={onContactPageChange}
        onAllPageChange={onAllPageChange}
        onNavigate={onNavigate}
      />

      <ConversationDrawer
        selectedItem={selectedItem}
        onSelectedItemChange={setSelectedItem}
        anchorMessageId={routeState.historyMessageId}
        onAfterClose={handleDrawerClosed}
        buildRoutineHref={buildRoutineHref}
      />
    </div>
  )
}
