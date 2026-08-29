'use client'

import { useState } from 'react'
import { Activity, CheckCircle2, FileText, Hand, MessageSquareText } from 'lucide-react'

import { ConversationToolbar } from '@/components/dashboard/history/conversation-toolbar'
import { DashboardPaginatedContent } from '@/components/dashboard/shared/dashboard-paginated-content'
import { DashboardPagination } from '@/components/dashboard/shared/dashboard-pagination'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import {
  DashboardTable,
  DashboardTableBody,
  DashboardTableCell,
  DashboardTableHead,
  DashboardTableHeader,
  DashboardTableRow,
} from '@/components/dashboard/shared/dashboard-table'
import { Button } from '@/components/ui/button'
import { LogoSpinner } from '@/components/ui/spinner'
import { editionController } from '@/lib/edition-controller'
import { type ChatConversationSummary, type ContactHistorySummary, type DocumentSearchHistoryEntry } from '@/lib/api'
import { getAgentOperatorLabel, getAgentPublicNameHint } from '@/lib/agent-label'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { useCopilotEntity } from '@/lib/copilot-context'
import { deriveConversationOutcome } from '@/lib/conversation-outcome'
import { EMPTY_CONVERSATION_FILTERS, filterConversations } from '@/lib/conversation-filters'
import { formatConversationLocation } from '@/lib/history-source'
import { stripTrackingParams } from '@/lib/inbox-response'
import { stripMarkdownSyntax } from '@/lib/markdown-preview'
import type { WorkspaceOnboardingState } from '@/lib/onboarding'

const formatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
})

export type HistoryFilter = 'all' | 'chat' | 'search' | 'contact'
export type SelectedHistoryItem =
  | { kind: 'chat'; id: string }
  | { kind: 'search'; id: string }
  | { kind: 'contact'; id: string }
  | null
export type HistoryListItem =
  | { kind: 'chat'; id: string; sortAt: string; conversation: ChatConversationSummary }
  | { kind: 'search'; id: string; sortAt: string; search: DocumentSearchHistoryEntry }
  | { kind: 'contact'; id: string; sortAt: string; contact: ContactHistorySummary }

const formatTimestamp = (value: string) => formatter.format(new Date(value))

const emptyAgentLabel = '—'

const formatPageSummary = ({
  currentPage,
  pageSize,
  pageItemCount,
  totalItems,
}: {
  currentPage: number
  pageSize: number
  pageItemCount: number
  totalItems: number
}) => {
  const pageStart = totalItems === 0 ? 0 : (currentPage - 1) * pageSize
  const pageEnd = Math.min(pageStart + pageItemCount, totalItems)

  return `${pageStart + 1} to ${pageEnd} of ${totalItems}`
}

function HistoryPagination({
  accountId,
  workspaceId,
  routeState,
  filter,
  currentPage,
  totalPages,
  pageSize,
  pageItemCount,
  totalItems,
  onPrevious,
  onNext,
}: {
  accountId: string
  workspaceId?: string
  routeState: DashboardRouteState
  filter: HistoryFilter
  currentPage: number
  totalPages: number
  pageSize: number
  pageItemCount: number
  totalItems: number
  onPrevious: () => void
  onNext: () => void
}) {
  return (
    <DashboardPagination
      summary={formatPageSummary({
        currentPage,
        pageSize,
        pageItemCount,
        totalItems,
      })}
      currentPage={currentPage}
      totalPages={totalPages}
      previousHref={buildDashboardHref(accountId, {
        ...routeState,
        section: 'activity',
        workspaceId,
        historyFilter: filter,
        historyPage: Math.max(1, currentPage - 1),
      })}
      nextHref={buildDashboardHref(accountId, {
        ...routeState,
        section: 'activity',
        workspaceId,
        historyFilter: filter,
        historyPage: Math.min(totalPages, currentPage + 1),
      })}
      onPrevious={onPrevious}
      onNext={onNext}
    />
  )
}

/** Maps a derived outcome to its chip markup. */
function ConversationOutcomeCell({
  conversation,
}: {
  conversation: ChatConversationSummary
}) {
  const outcome = deriveConversationOutcome(conversation, new Date())

  if (outcome.kind === 'handed_off') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
        <Hand className="h-3 w-3" aria-hidden />
        Handed off
      </span>
    )
  }

  if (outcome.kind === 'in_progress') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs font-medium text-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
        In progress
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
      <CheckCircle2 className="h-3 w-3" aria-hidden />
      Completed
    </span>
  )
}

/** The visitor-identity + location meta line under a conversation's title. */
function ConversationMetaLine({ conversation }: { conversation: ChatConversationSummary }) {
  const visitorLabel = conversation.anonymousSessionId === null ? 'Verified' : 'Anonymous'
  const location = formatConversationLocation(conversation)
  const isSlack = conversation.channelContext?.provider === 'slack'
  const trimmedEntryPageUrl = conversation.entryPageUrl?.trim() || null

  let locationText = location.text
  let locationHref: string | null = null

  if (!isSlack && trimmedEntryPageUrl) {
    const stripped = stripTrackingParams(trimmedEntryPageUrl)
    locationText = stripped.replace(/^https?:\/\//, '')
    // location.href is derived from this same entryPageUrl when it parses as a URL — only
    // then is there a real page to open, so reuse it to decide link vs plain text.
    locationHref = location.href ? stripped : null
  }

  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <span className="shrink-0">{visitorLabel}</span>
      <span aria-hidden>·</span>
      {locationHref ? (
        <a
          href={locationHref}
          target="_blank"
          rel="noopener noreferrer"
          title={locationHref}
          onClick={(event) => event.stopPropagation()}
          className="min-w-0 truncate hover:text-primary"
        >
          {locationText}
        </a>
      ) : (
        <span className="min-w-0 truncate" title={location.title ?? undefined}>{locationText}</span>
      )}
    </span>
  )
}

function ConversationRow({
  conversation,
  onSelect,
}: {
  conversation: ChatConversationSummary
  onSelect: (item: SelectedHistoryItem) => void
}) {
  useCopilotEntity('conversation', conversation.id, conversation.preview || 'Untitled conversation')
  useCopilotEntity(
    'agent',
    conversation.agentId,
    getAgentOperatorLabel({ internalName: conversation.agentInternalName, name: conversation.agentName }, 'Unknown agent'),
  )
  const publicNameHint = getAgentPublicNameHint({
    internalName: conversation.agentInternalName,
    name: conversation.agentName,
  })

  return (
    <DashboardTableRow>
      <DashboardTableCell className="w-[44%]">
        <button
          type="button"
          onClick={() => onSelect({ kind: 'chat', id: conversation.id })}
          className="block max-w-full text-left text-sm font-medium leading-5 text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="block truncate">{stripMarkdownSyntax(conversation.preview || '') || 'Untitled conversation'}</span>
        </button>
        <ConversationMetaLine conversation={conversation} />
      </DashboardTableCell>
      <DashboardTableCell>
        <ConversationOutcomeCell conversation={conversation} />
      </DashboardTableCell>
      <DashboardTableCell className="text-sm text-muted-foreground">
        <span
          className="block truncate"
          title={publicNameHint ?? undefined}
        >
          {getAgentOperatorLabel({ internalName: conversation.agentInternalName, name: conversation.agentName }, conversation.agentId ? 'Unknown agent' : 'No agent')}
        </span>
      </DashboardTableCell>
      <DashboardTableCell className="text-right text-sm text-muted-foreground">
        {conversation.messageCount}
      </DashboardTableCell>
      <DashboardTableCell className="text-sm text-muted-foreground">
        {formatTimestamp(conversation.updatedAt)}
      </DashboardTableCell>
    </DashboardTableRow>
  )
}

function SearchRow({
  search,
  onSelect,
}: {
  search: DocumentSearchHistoryEntry
  onSelect: (item: SelectedHistoryItem) => void
}) {
  const resultLabel = search.resultCount === 1 ? '1 result' : `${search.resultCount} results`

  return (
    <DashboardTableRow>
      <DashboardTableCell className="w-[44%]">
        <button
          type="button"
          onClick={() => onSelect({ kind: 'search', id: search.searchId })}
          className="block max-w-full text-left text-sm font-medium leading-5 text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="block truncate">{search.query}</span>
        </button>
        {search.previewTopTitles.length > 0 ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">
            Top match: {search.previewTopTitles[0]}
          </p>
        ) : null}
        {/* Real information that would otherwise be lost when the old Details column is dropped. */}
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          Authenticated - {resultLabel}
          {search.activityTraceAvailable ? ' - trace available' : ''}
        </p>
      </DashboardTableCell>
      {/* No outcome data exists for document searches — a genuine gap, left empty rather than faked. */}
      <DashboardTableCell>{null}</DashboardTableCell>
      <DashboardTableCell className="text-sm text-muted-foreground">
        <span className="block truncate">{emptyAgentLabel}</span>
      </DashboardTableCell>
      <DashboardTableCell className="text-right text-sm text-muted-foreground">—</DashboardTableCell>
      <DashboardTableCell className="text-sm text-muted-foreground">
        {formatTimestamp(search.createdAt)}
      </DashboardTableCell>
    </DashboardTableRow>
  )
}

function ContactRow({
  contact,
  onSelect,
}: {
  contact: ContactHistorySummary
  onSelect: (item: SelectedHistoryItem) => void
}) {
  const location = formatConversationLocation(contact)

  return (
    <DashboardTableRow>
      <DashboardTableCell className="w-[44%]">
        <button
          type="button"
          onClick={() => onSelect({ kind: 'contact', id: contact.id })}
          className="block max-w-full text-left text-sm font-medium leading-5 text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="block truncate">{contact.messagePreview || 'Contact request'}</span>
        </button>
        <p className="mt-1 truncate text-xs text-muted-foreground">{contact.messagePreview}</p>
        {/* Location and email/status are real information folded in from the now-dropped Source/Details columns. */}
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{location.text}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{contact.userEmail} - {contact.status}</p>
      </DashboardTableCell>
      {/* No outcome data exists for contact requests — a genuine gap, left empty rather than faked. */}
      <DashboardTableCell>{null}</DashboardTableCell>
      <DashboardTableCell className="text-sm text-muted-foreground">
        <span className="block truncate">{emptyAgentLabel}</span>
      </DashboardTableCell>
      <DashboardTableCell className="text-right text-sm text-muted-foreground">—</DashboardTableCell>
      <DashboardTableCell className="text-sm text-muted-foreground">
        {formatTimestamp(contact.createdAt)}
      </DashboardTableCell>
    </DashboardTableRow>
  )
}

function HistoryTable({
  items,
  emptyMessage,
  onSelect,
}: {
  items: HistoryListItem[]
  emptyMessage: string
  onSelect: (item: SelectedHistoryItem) => void
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }

  return (
    <DashboardTable aria-label="Conversations" minWidth="min-w-[980px]">
      <DashboardTableHead>
        <DashboardTableHeader className="w-[44%]">Conversation</DashboardTableHeader>
        <DashboardTableHeader>Outcome</DashboardTableHeader>
        <DashboardTableHeader>Agent</DashboardTableHeader>
        <DashboardTableHeader className="text-right">Msgs</DashboardTableHeader>
        <DashboardTableHeader>Last activity</DashboardTableHeader>
      </DashboardTableHead>
      <DashboardTableBody>
        {items.map((item) =>
          item.kind === 'chat' ? (
            <ConversationRow
              key={item.id}
              conversation={item.conversation}
              onSelect={onSelect}
            />
          ) : item.kind === 'search' ? (
            <SearchRow key={item.id} search={item.search} onSelect={onSelect} />
          ) : (
            <ContactRow key={item.id} contact={item.contact} onSelect={onSelect} />
          ),
        )}
      </DashboardTableBody>
    </DashboardTable>
  )
}

export function HistoryList({
  accountId,
  workspaceId,
  routeState,
  onboarding,
  filter,
  isLoading,
  hasAnyHistory,
  listError,
  pageSize,
  conversations,
  conversationTotal,
  conversationPage,
  conversationTotalPages,
  searches,
  searchTotal,
  searchPage,
  searchTotalPages,
  contacts,
  contactTotal,
  contactPage,
  contactTotalPages,
  allHistoryItems,
  allTotal,
  allPage,
  allTotalPages,
  onSelectItem,
  onConversationPageChange,
  onSearchPageChange,
  onContactPageChange,
  onAllPageChange,
  onNavigate,
}: {
  accountId: string
  workspaceId?: string
  routeState: DashboardRouteState
  onboarding: WorkspaceOnboardingState
  filter: HistoryFilter
  isLoading: boolean
  hasAnyHistory: boolean
  listError: string | null
  pageSize: number
  conversations: ChatConversationSummary[]
  conversationTotal: number
  conversationPage: number
  conversationTotalPages: number
  searches: DocumentSearchHistoryEntry[]
  searchTotal: number
  searchPage: number
  searchTotalPages: number
  contacts: ContactHistorySummary[]
  contactTotal: number
  contactPage: number
  contactTotalPages: number
  allHistoryItems: HistoryListItem[]
  allTotal: number
  allPage: number
  allTotalPages: number
  onFilterChange: (filter: HistoryFilter) => void
  onSelectItem: (item: SelectedHistoryItem) => void
  onConversationPageChange: (page: number) => void
  onSearchPageChange: (page: number) => void
  onContactPageChange: (page: number) => void
  onAllPageChange: (page: number) => void
  onNavigate: (href: string) => void
}) {
  // The kind selector was removed, so All activity shows chats and searches together by
  // default. URL-level filtering (?filter=) is still honored for deep links.
  const activeFilter = editionController.normalizeHistoryFilter(filter)
  const visibleAllHistoryItems = editionController.filterActivityItems(allHistoryItems)

  // Toolbar filters are local UI state, not URL-addressable: chatApi.listChatHistory only
  // accepts limit/offset, so there is no server-side agent/outcome/site filter to route to.
  const [conversationFilters, setConversationFilters] = useState(EMPTY_CONVERSATION_FILTERS)
  // Filters apply only to the currently loaded page of conversations, never the full result
  // set behind pagination — see the comment on filterConversations for why.
  const filteredConversations = filterConversations(conversations, conversationFilters, new Date())

  return (
    <DashboardPage
      title="Conversations"
    >
        {isLoading && !hasAnyHistory ? (
          <div className="flex h-full items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </div>
        ) : !hasAnyHistory ? (
          <div className="space-y-6">
            {listError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {listError}
              </div>
            ) : null}
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Activity className="h-5 w-5 text-primary" />
              </div>
              <h2 className="text-lg font-medium text-foreground">No activity yet</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {activeFilter === 'chat'
                  ? onboarding.hasReadyDocuments
                    ? 'Your workspace is ready. Ask the first question and it will appear here.'
                    : 'Load content first, then ask one question. Conversation activity will appear here after that.'
                  : activeFilter === 'search'
                    ? 'Document searches will appear here after someone runs a search.'
                    : onboarding.hasReadyDocuments
                      ? 'Your workspace is ready. Ask the first question or run a document search to start building activity.'
                      : 'Load content first, then ask one question or run a document search. Activity will appear here after that.'}
              </p>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {activeFilter !== 'search' && onboarding.hasReadyDocuments ? (
                <Button
                  size="sm"
                  onClick={() => onNavigate(buildDashboardHref(accountId, {
                    section: 'agents',
                    workspaceId,
                  }))}
                >
                  <MessageSquareText className="mr-2 h-4 w-4" />
                  Ask first question
                </Button>
              ) : null}
              {(activeFilter === 'chat' || activeFilter === 'all') && !onboarding.hasReadyDocuments ? (
                <Button
                  size="sm"
                  onClick={() => onNavigate(buildDashboardHref(accountId, {
                    section: 'knowledge',
                    workspaceId,
                  }))}
                >
                  <FileText className="mr-2 h-4 w-4" />
                  Open documents
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {listError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {listError}
              </div>
            ) : null}
            {activeFilter === 'all' ? (
              <DashboardPaginatedContent
                as="section"
                className="space-y-3"
                isRefreshing={isLoading && visibleAllHistoryItems.length > 0}
              >
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="all"
                  currentPage={allPage}
                  totalPages={allTotalPages}
                  pageSize={pageSize}
                  pageItemCount={isLoading ? pageSize : visibleAllHistoryItems.length}
                  totalItems={allTotal}
                  onPrevious={() => onAllPageChange(Math.max(1, allPage - 1))}
                  onNext={() => onAllPageChange(Math.min(allTotalPages, allPage + 1))}
                />
                {isLoading && visibleAllHistoryItems.length === 0 ? (
                  <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border">
                    <LogoSpinner imageClassName="h-7 w-7" />
                  </div>
                ) : (
                  <HistoryTable
                    items={visibleAllHistoryItems}
                    emptyMessage="No saved activity on this page."
                    onSelect={onSelectItem}
                  />
                )}
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="all"
                  currentPage={allPage}
                  totalPages={allTotalPages}
                  pageSize={pageSize}
                  pageItemCount={isLoading ? pageSize : visibleAllHistoryItems.length}
                  totalItems={allTotal}
                  onPrevious={() => onAllPageChange(Math.max(1, allPage - 1))}
                  onNext={() => onAllPageChange(Math.min(allTotalPages, allPage + 1))}
                />
              </DashboardPaginatedContent>
            ) : null}
            {activeFilter === 'chat' ? (
              <DashboardPaginatedContent
                as="section"
                className="space-y-3"
                isRefreshing={isLoading && conversations.length > 0}
              >
                <ConversationToolbar
                  conversations={conversations}
                  filters={conversationFilters}
                  onFiltersChange={setConversationFilters}
                />
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="chat"
                  currentPage={conversationPage}
                  totalPages={conversationTotalPages}
                  pageSize={pageSize}
                  pageItemCount={isLoading ? pageSize : conversations.length}
                  totalItems={conversationTotal}
                  onPrevious={() => onConversationPageChange(Math.max(1, conversationPage - 1))}
                  onNext={() => onConversationPageChange(Math.min(conversationTotalPages, conversationPage + 1))}
                />
                {isLoading && conversations.length === 0 ? (
                  <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border">
                    <LogoSpinner imageClassName="h-7 w-7" />
                  </div>
                ) : (
                  <HistoryTable
                    items={filteredConversations.map((conversation) => ({
                      kind: 'chat',
                      id: conversation.id,
                      sortAt: conversation.updatedAt,
                      conversation,
                    }))}
                    emptyMessage={
                      conversations.length > 0 && filteredConversations.length === 0
                        ? 'No conversations match the current filters.'
                        : 'No saved chats on this page.'
                    }
                    onSelect={onSelectItem}
                  />
                )}
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="chat"
                  currentPage={conversationPage}
                  totalPages={conversationTotalPages}
                  pageSize={pageSize}
                  pageItemCount={isLoading ? pageSize : conversations.length}
                  totalItems={conversationTotal}
                  onPrevious={() => onConversationPageChange(Math.max(1, conversationPage - 1))}
                  onNext={() => onConversationPageChange(Math.min(conversationTotalPages, conversationPage + 1))}
                />
              </DashboardPaginatedContent>
            ) : null}
            {activeFilter === 'search' ? (
              <DashboardPaginatedContent
                as="section"
                className="space-y-3"
                isRefreshing={isLoading && searches.length > 0}
              >
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="search"
                  currentPage={searchPage}
                  totalPages={searchTotalPages}
                  pageSize={pageSize}
                  pageItemCount={isLoading ? pageSize : searches.length}
                  totalItems={searchTotal}
                  onPrevious={() => onSearchPageChange(Math.max(1, searchPage - 1))}
                  onNext={() => onSearchPageChange(Math.min(searchTotalPages, searchPage + 1))}
                />
                {isLoading && searches.length === 0 ? (
                  <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border">
                    <LogoSpinner imageClassName="h-7 w-7" />
                  </div>
                ) : (
                  <HistoryTable
                    items={searches.map((search) => ({
                      kind: 'search',
                      id: search.searchId,
                      sortAt: search.createdAt,
                      search,
                    }))}
                    emptyMessage="No saved searches on this page."
                    onSelect={onSelectItem}
                  />
                )}
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="search"
                  currentPage={searchPage}
                  totalPages={searchTotalPages}
                  pageSize={pageSize}
                  pageItemCount={isLoading ? pageSize : searches.length}
                  totalItems={searchTotal}
                  onPrevious={() => onSearchPageChange(Math.max(1, searchPage - 1))}
                  onNext={() => onSearchPageChange(Math.min(searchTotalPages, searchPage + 1))}
                />
              </DashboardPaginatedContent>
            ) : null}
            {activeFilter === 'contact' ? (
              <DashboardPaginatedContent
                as="section"
                className="space-y-3"
                isRefreshing={isLoading && contacts.length > 0}
              >
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="contact"
                  currentPage={contactPage}
                  totalPages={contactTotalPages}
                  pageSize={pageSize}
                  pageItemCount={isLoading ? pageSize : contacts.length}
                  totalItems={contactTotal}
                  onPrevious={() => onContactPageChange(Math.max(1, contactPage - 1))}
                  onNext={() => onContactPageChange(Math.min(contactTotalPages, contactPage + 1))}
                />
                {isLoading && contacts.length === 0 ? (
                  <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border">
                    <LogoSpinner imageClassName="h-7 w-7" />
                  </div>
                ) : (
                  <HistoryTable
                    items={contacts.map((contact) => ({
                      kind: 'contact',
                      id: contact.id,
                      sortAt: contact.sortAt,
                      contact,
                    }))}
                    emptyMessage="No saved contact requests on this page."
                    onSelect={onSelectItem}
                  />
                )}
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="contact"
                  currentPage={contactPage}
                  totalPages={contactTotalPages}
                  pageSize={pageSize}
                  pageItemCount={isLoading ? pageSize : contacts.length}
                  totalItems={contactTotal}
                  onPrevious={() => onContactPageChange(Math.max(1, contactPage - 1))}
                  onNext={() => onContactPageChange(Math.min(contactTotalPages, contactPage + 1))}
                />
              </DashboardPaginatedContent>
            ) : null}
          </div>
        )}
    </DashboardPage>
  )
}
