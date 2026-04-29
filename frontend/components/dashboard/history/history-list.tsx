'use client'

import { FileText, Globe2, History, MessageSquareText } from 'lucide-react'

import { DashboardPagination } from '@/components/dashboard/shared/dashboard-pagination'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { Button } from '@/components/ui/button'
import { LogoSpinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { ChatConversationSummary, DocumentSearchHistoryEntry } from '@/lib/api'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
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

const formatHost = (origin: string | null) => {
  if (!origin) {
    return null
  }

  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

const getConversationAuthLabel = (sourceChannel: string | null) => {
  if (sourceChannel === 'anonymous') {
    return 'Anonymous'
  }

  if (sourceChannel === 'website_embed') {
    return 'Embedded'
  }

  if (sourceChannel === 'mcp') {
    return 'MCP'
  }

  return 'Authenticated'
}

const getConversationSourceLabel = (conversation: ChatConversationSummary) => {
  const host = formatHost(conversation.sourceOrigin)
  if (host) {
    return host
  }

  if (conversation.sourceChannel === 'anonymous') {
    return 'Public chat'
  }

  if (conversation.sourceChannel === 'website_embed') {
    return 'Website embed'
  }

  if (conversation.sourceChannel === 'mcp') {
    return 'MCP'
  }

  return 'Dashboard chat'
}

function HistoryBadge({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  )
}

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
  const sourceLabel = getConversationSourceLabel(conversation)

  return (
    <button
      type="button"
      onClick={() => onSelect({ kind: 'chat', id: conversation.id })}
      className="flex w-full flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3.5 text-left transition hover:border-primary/40 hover:bg-accent/30"
    >
      <div className="flex flex-wrap items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium leading-6 text-foreground [overflow-wrap:anywhere]">
          {conversation.preview || 'Untitled conversation'}
        </p>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <HistoryBadge>Chat</HistoryBadge>
          <HistoryBadge>{getConversationAuthLabel(conversation.sourceChannel)}</HistoryBadge>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Globe2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{sourceLabel}</span>
        </span>
        <span className="shrink-0 sm:ml-auto">{formatTimestamp(conversation.updatedAt)}</span>
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
      className="flex w-full flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3.5 text-left transition hover:border-primary/40 hover:bg-accent/30"
    >
      <div className="flex flex-wrap items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium leading-6 text-foreground [overflow-wrap:anywhere]">
          {search.query}
        </p>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <HistoryBadge>Search</HistoryBadge>
          <HistoryBadge>Authenticated</HistoryBadge>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Globe2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            Document search
            {search.resultCount > 0
              ? ` - ${search.resultCount} result${search.resultCount === 1 ? '' : 's'}`
              : ''}
          </span>
        </span>
        <span className="shrink-0 sm:ml-auto">{formatTimestamp(search.createdAt)}</span>
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
    <DashboardPage
      title="History"
      description="Review past chats and searches. Retrieval diagnostics live here."
      actions={
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
      }
      actionsClassName="xl:self-start"
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
                  pageItemCount={isLoading ? pageSize : allHistoryItems.length}
                  totalItems={allTotal}
                  onPrevious={() => onAllPageChange(Math.max(1, allPage - 1))}
                  onNext={() => onAllPageChange(Math.min(allTotalPages, allPage + 1))}
                />
                {isLoading ? (
                  <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border">
                    <LogoSpinner imageClassName="h-7 w-7" />
                  </div>
                ) : (
                  allHistoryItems.map((item) =>
                    item.kind === 'chat' ? (
                      <ConversationCard
                        key={item.id}
                        conversation={item.conversation}
                        onSelect={onSelectItem}
                      />
                    ) : (
                      <SearchCard key={item.id} search={item.search} onSelect={onSelectItem} />
                    ),
                  )
                )}
                <HistoryPagination
                  accountId={accountId}
                  workspaceId={workspaceId}
                  routeState={routeState}
                  filter="all"
                  currentPage={allPage}
                  totalPages={allTotalPages}
                  pageSize={pageSize}
                  pageItemCount={isLoading ? pageSize : allHistoryItems.length}
                  totalItems={allTotal}
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
                  pageItemCount={isLoading ? pageSize : conversations.length}
                  totalItems={conversationTotal}
                  onPrevious={() => onConversationPageChange(Math.max(1, conversationPage - 1))}
                  onNext={() => onConversationPageChange(Math.min(conversationTotalPages, conversationPage + 1))}
                />
                {isLoading ? (
                  <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border">
                    <LogoSpinner imageClassName="h-7 w-7" />
                  </div>
                ) : conversations.length === 0 ? (
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
                  pageItemCount={isLoading ? pageSize : conversations.length}
                  totalItems={conversationTotal}
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
                  pageItemCount={isLoading ? pageSize : searches.length}
                  totalItems={searchTotal}
                  onPrevious={() => onSearchPageChange(Math.max(1, searchPage - 1))}
                  onNext={() => onSearchPageChange(Math.min(searchTotalPages, searchPage + 1))}
                />
                {isLoading ? (
                  <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border">
                    <LogoSpinner imageClassName="h-7 w-7" />
                  </div>
                ) : searches.length === 0 ? (
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
                  pageItemCount={isLoading ? pageSize : searches.length}
                  totalItems={searchTotal}
                  onPrevious={() => onSearchPageChange(Math.max(1, searchPage - 1))}
                  onNext={() => onSearchPageChange(Math.min(searchTotalPages, searchPage + 1))}
                />
              </section>
            ) : null}
          </div>
        )}
    </DashboardPage>
  )
}
