'use client'

import { FileText, History, MessageSquareText } from 'lucide-react'

import { DashboardPagination } from '@/components/dashboard/shared/dashboard-pagination'
import { Button } from '@/components/ui/button'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { ChatConversationSummary, DocumentSearchHistoryEntry } from '@/lib/api'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { getConversationSourceBadge } from '@/lib/history-source'
import type { WorkspaceOnboardingState } from '@/lib/onboarding'

const formatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
})

export type HistoryFilter = 'all' | 'chat' | 'search'
export type SelectedHistoryItem =
  | { kind: 'chat'; id: string }
  | { kind: 'search'; id: string }
  | null
export type HistoryListItem =
  | { kind: 'chat'; id: string; sortAt: string; conversation: ChatConversationSummary }
  | { kind: 'search'; id: string; sortAt: string; search: DocumentSearchHistoryEntry }

const formatTimestamp = (value: string) => formatter.format(new Date(value))

const formatPageSummary = ({
  currentPage,
  pageSize,
  pageItemCount,
  totalItems,
  label,
}: {
  currentPage: number
  pageSize: number
  pageItemCount: number
  totalItems: number
  label: string
}) => {
  const pageStart = totalItems === 0 ? 0 : (currentPage - 1) * pageSize
  const pageEnd = Math.min(pageStart + pageItemCount, totalItems)

  return `Showing ${pageStart + 1}-${pageEnd} of ${totalItems} ${label}`
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
  label,
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
  label: string
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
        label,
      })}
      currentPage={currentPage}
      totalPages={totalPages}
      previousHref={buildDashboardHref(accountId, {
        ...routeState,
        section: 'history',
        workspaceId,
        historyFilter: filter,
        historyPage: Math.max(1, currentPage - 1),
      })}
      nextHref={buildDashboardHref(accountId, {
        ...routeState,
        section: 'history',
        workspaceId,
        historyFilter: filter,
        historyPage: Math.min(totalPages, currentPage + 1),
      })}
      onPrevious={onPrevious}
      onNext={onNext}
    />
  )
}

function ConversationCard({
  conversation,
  onSelect,
}: {
  conversation: ChatConversationSummary
  onSelect: (item: SelectedHistoryItem) => void
}) {
  const sourceHost = conversation.sourceOrigin
    ? (() => {
        try {
          return new URL(conversation.sourceOrigin).host
        } catch {
          return conversation.sourceOrigin
        }
      })()
    : null
  const sourceBadge = getConversationSourceBadge(conversation.sourceChannel)

  return (
    <button
      type="button"
      onClick={() => onSelect({ kind: 'chat', id: conversation.id })}
      className="w-full rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:bg-accent/40"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              Chat
            </span>
            <p className="font-medium text-foreground">{conversation.preview || 'Untitled conversation'}</p>
          </div>
          <p className="text-xs text-muted-foreground">{conversation.id}</p>
        </div>
        <p className="text-xs text-muted-foreground">Updated {formatTimestamp(conversation.updatedAt)}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
        {sourceBadge ? <span className={sourceBadge.className}>{sourceBadge.label}</span> : null}
        {sourceHost ? <span className="rounded-full bg-muted px-2.5 py-1">{sourceHost}</span> : null}
        <span className="rounded-full bg-muted px-2.5 py-1">{conversation.messageCount} messages</span>
        <span className="rounded-full bg-muted px-2.5 py-1">{conversation.userMessageCount} user</span>
        <span className="rounded-full bg-muted px-2.5 py-1">{conversation.assistantMessageCount} assistant</span>
      </div>
    </button>
  )
}

function SearchCard({
  search,
  onSelect,
}: {
  search: DocumentSearchHistoryEntry
  onSelect: (item: SelectedHistoryItem) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect({ kind: 'search', id: search.searchId })}
      className="w-full rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:bg-accent/40"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              Search
            </span>
            <p className="font-medium text-foreground">{search.query}</p>
          </div>
          <p className="text-xs text-muted-foreground">{search.searchId}</p>
        </div>
        <p className="text-xs text-muted-foreground">Searched {formatTimestamp(search.createdAt)}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span className="rounded-full bg-muted px-2.5 py-1">
          {search.resultCount} document{search.resultCount === 1 ? '' : 's'} retrieved
        </span>
        {search.traceAvailable ? (
          <span className="rounded-full bg-muted px-2.5 py-1">Diagnostics available</span>
        ) : null}
      </div>
    </button>
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
  allHistoryItems,
  allPage,
  allTotalPages,
  onFilterChange,
  onSelectItem,
  onConversationPageChange,
  onSearchPageChange,
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
  allHistoryItems: HistoryListItem[]
  allPage: number
  allTotalPages: number
  onFilterChange: (filter: HistoryFilter) => void
  onSelectItem: (item: SelectedHistoryItem) => void
  onConversationPageChange: (page: number) => void
  onSearchPageChange: (page: number) => void
  onAllPageChange: (page: number) => void
  onNavigate: (href: string) => void
}) {
  const allTotal = conversationTotal + searchTotal

  return (
    <>
      <div className="sticky top-0 z-20 shrink-0 border-b border-border bg-background/95 px-6 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-lg font-medium text-foreground">History</h1>
            <p className="text-sm text-muted-foreground">
              Review past chats and searches. Retrieval diagnostics live here.
            </p>
          </div>
          <div className="lg:ml-auto lg:self-start">
            <div className="bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]">
              {([
                { value: 'all', label: 'All' },
                { value: 'chat', label: 'Chats' },
                { value: 'search', label: 'Searches' },
              ] as const).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onFilterChange(option.value)}
                  className={cn(
                    'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground transition-[color,box-shadow,background-color] focus-visible:ring-[3px] focus-visible:outline-1',
                    filter === option.value
                      ? 'bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30 dark:text-foreground'
                      : 'dark:text-muted-foreground',
                  )}
                  aria-pressed={filter === option.value}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {isLoading ? (
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
                <History className="h-5 w-5 text-primary" />
              </div>
              <h2 className="text-lg font-medium text-foreground">No history yet</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {filter === 'chat'
                  ? onboarding.hasReadyDocuments
                    ? 'Your workspace is ready. Ask the first question and it will appear here.'
                    : 'Load content first, then ask one question. Conversation history will appear here after that.'
                  : filter === 'search'
                    ? 'Document searches will appear here after someone runs a search.'
                    : onboarding.hasReadyDocuments
                      ? 'Your workspace is ready. Ask the first question or run a document search to start building history.'
                      : 'Load content first, then ask one question or run a document search. History will appear here after that.'}
              </p>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {filter !== 'search' && onboarding.hasReadyDocuments ? (
                <Button
                  size="sm"
                  onClick={() => onNavigate(buildDashboardHref(accountId, {
                    section: 'chat',
                    workspaceId,
                  }))}
                >
                  <MessageSquareText className="mr-2 h-4 w-4" />
                  Ask first question
                </Button>
              ) : null}
              {(filter === 'chat' || filter === 'all') && !onboarding.hasReadyDocuments ? (
                <Button
                  size="sm"
                  onClick={() => onNavigate(buildDashboardHref(accountId, {
                    section: 'documents',
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
            {filter === 'all' ? (
              <>
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="all"
                  currentPage={allPage}
                  totalPages={allTotalPages}
                  pageSize={pageSize}
                  pageItemCount={allHistoryItems.length}
                  totalItems={allTotal}
                  label="history items"
                  onPrevious={() => onAllPageChange(Math.max(1, allPage - 1))}
                  onNext={() => onAllPageChange(Math.min(allTotalPages, allPage + 1))}
                />
                {allHistoryItems.map((item) =>
                  item.kind === 'chat' ? (
                    <ConversationCard
                      key={item.id}
                      conversation={item.conversation}
                      onSelect={onSelectItem}
                    />
                  ) : (
                    <SearchCard key={item.id} search={item.search} onSelect={onSelectItem} />
                  ),
                )}
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="all"
                  currentPage={allPage}
                  totalPages={allTotalPages}
                  pageSize={pageSize}
                  pageItemCount={allHistoryItems.length}
                  totalItems={allTotal}
                  label="history items"
                  onPrevious={() => onAllPageChange(Math.max(1, allPage - 1))}
                  onNext={() => onAllPageChange(Math.min(allTotalPages, allPage + 1))}
                />
              </>
            ) : null}
            {filter === 'chat' ? (
              <section className="space-y-3">
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="chat"
                  currentPage={conversationPage}
                  totalPages={conversationTotalPages}
                  pageSize={pageSize}
                  pageItemCount={conversations.length}
                  totalItems={conversationTotal}
                  label="conversations"
                  onPrevious={() => onConversationPageChange(Math.max(1, conversationPage - 1))}
                  onNext={() => onConversationPageChange(Math.min(conversationTotalPages, conversationPage + 1))}
                />
                {conversations.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                    No saved chats on this page.
                  </div>
                ) : (
                  conversations.map((conversation) => (
                    <ConversationCard
                      key={conversation.id}
                      conversation={conversation}
                      onSelect={onSelectItem}
                    />
                  ))
                )}
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="chat"
                  currentPage={conversationPage}
                  totalPages={conversationTotalPages}
                  pageSize={pageSize}
                  pageItemCount={conversations.length}
                  totalItems={conversationTotal}
                  label="conversations"
                  onPrevious={() => onConversationPageChange(Math.max(1, conversationPage - 1))}
                  onNext={() => onConversationPageChange(Math.min(conversationTotalPages, conversationPage + 1))}
                />
              </section>
            ) : null}
            {filter === 'search' ? (
              <section className="space-y-3">
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="search"
                  currentPage={searchPage}
                  totalPages={searchTotalPages}
                  pageSize={pageSize}
                  pageItemCount={searches.length}
                  totalItems={searchTotal}
                  label="searches"
                  onPrevious={() => onSearchPageChange(Math.max(1, searchPage - 1))}
                  onNext={() => onSearchPageChange(Math.min(searchTotalPages, searchPage + 1))}
                />
                {searches.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                    No saved searches on this page.
                  </div>
                ) : (
                  searches.map((search) => <SearchCard key={search.searchId} search={search} onSelect={onSelectItem} />)
                )}
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="search"
                  currentPage={searchPage}
                  totalPages={searchTotalPages}
                  pageSize={pageSize}
                  pageItemCount={searches.length}
                  totalItems={searchTotal}
                  label="searches"
                  onPrevious={() => onSearchPageChange(Math.max(1, searchPage - 1))}
                  onNext={() => onSearchPageChange(Math.min(searchTotalPages, searchPage + 1))}
                />
              </section>
            ) : null}
          </div>
        )}
      </div>
    </>
  )
}
