'use client'

import { Activity, FileText, MessageSquareText } from 'lucide-react'

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
import { cn } from '@/lib/utils'
import { editionController } from '@/lib/edition-controller'
import type { ChatConversationSummary, ContactHistorySummary, DocumentSearchHistoryEntry } from '@/lib/api'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
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

const getConversationSourceLabel = (conversation: Pick<ChatConversationSummary, 'sourceChannel' | 'sourceOrigin'>) => {
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

const formatMessageCount = (messageCount: number) =>
  `${messageCount} message${messageCount === 1 ? '' : 's'}`

const getConversationAgentLabel = (conversation: Pick<ChatConversationSummary, 'agentName' | 'agentId'>) => {
  const name = conversation.agentName?.trim()
  if (name) {
    return name
  }

  return conversation.agentId ? 'Unknown agent' : 'No agent'
}

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

function ConversationRow({
  conversation,
  onSelect,
}: {
  conversation: ChatConversationSummary
  onSelect: (item: SelectedHistoryItem) => void
}) {
  const sourceLabel = getConversationSourceLabel(conversation)

  return (
    <DashboardTableRow>
      <DashboardTableCell className="w-36">
        <span className="block truncate text-sm text-muted-foreground">{getConversationAgentLabel(conversation)}</span>
      </DashboardTableCell>
      <DashboardTableCell>
        <button
          type="button"
          onClick={() => onSelect({ kind: 'chat', id: conversation.id })}
          className="block max-w-full text-left text-sm font-medium leading-5 text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="block truncate">{conversation.preview || 'Untitled conversation'}</span>
        </button>
      </DashboardTableCell>
      <DashboardTableCell className="w-44 text-sm text-muted-foreground">
        <span className="block truncate">{sourceLabel}</span>
      </DashboardTableCell>
      <DashboardTableCell className="w-48 text-sm text-muted-foreground">
        <span className="block truncate">
          {getConversationAuthLabel(conversation.sourceChannel)} - {formatMessageCount(conversation.messageCount)}
        </span>
      </DashboardTableCell>
      <DashboardTableCell className="w-48 text-sm text-muted-foreground">
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
      <DashboardTableCell className="w-36">
        <span className="block truncate text-sm text-muted-foreground">{emptyAgentLabel}</span>
      </DashboardTableCell>
      <DashboardTableCell>
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
      </DashboardTableCell>
      <DashboardTableCell className="w-44 text-sm text-muted-foreground">Document search</DashboardTableCell>
      <DashboardTableCell className="w-48 text-sm text-muted-foreground">
        <span className="block truncate">
          Authenticated - {resultLabel}
          {search.activityTraceAvailable ? ' - trace available' : ''}
        </span>
      </DashboardTableCell>
      <DashboardTableCell className="w-48 text-sm text-muted-foreground">
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
  return (
    <DashboardTableRow>
      <DashboardTableCell className="w-36">
        <span className="block truncate text-sm text-muted-foreground">{emptyAgentLabel}</span>
      </DashboardTableCell>
      <DashboardTableCell>
        <button
          type="button"
          onClick={() => onSelect({ kind: 'contact', id: contact.id })}
          className="block max-w-full text-left text-sm font-medium leading-5 text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="block truncate">{contact.messagePreview || 'Talk to a human request'}</span>
        </button>
        <p className="mt-1 truncate text-xs text-muted-foreground">{contact.messagePreview}</p>
      </DashboardTableCell>
      <DashboardTableCell className="w-44 text-sm text-muted-foreground">
        <span className="block truncate">{getConversationSourceLabel(contact)}</span>
      </DashboardTableCell>
      <DashboardTableCell className="w-48 text-sm text-muted-foreground">
        <span className="block truncate">{contact.userEmail} - {contact.status}</span>
      </DashboardTableCell>
      <DashboardTableCell className="w-48 text-sm text-muted-foreground">
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
    <DashboardTable aria-label="Activity" minWidth="min-w-[880px]">
      <DashboardTableHead>
        <DashboardTableHeader className="w-36">Agent</DashboardTableHeader>
        <DashboardTableHeader>Title</DashboardTableHeader>
        <DashboardTableHeader className="w-44">Source</DashboardTableHeader>
        <DashboardTableHeader className="w-48">Details</DashboardTableHeader>
        <DashboardTableHeader className="w-48">Updated</DashboardTableHeader>
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
  onFilterChange,
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
  const activeFilter = editionController.normalizeHistoryFilter(filter)
  const filterOptions = editionController.getActivityFilterOptions()
  const visibleAllHistoryItems = editionController.filterActivityItems(allHistoryItems)

  return (
    <DashboardPage
      title="Activity"
      description={
        editionController.getActivityDescription()
      }
      actions={
        <div className="bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]">
              {filterOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onFilterChange(option.value)}
                  className={cn(
                    'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground transition-[color,box-shadow,background-color] hover:text-primary focus-visible:ring-[3px] focus-visible:outline-1 dark:hover:text-secondary',
                    activeFilter === option.value
                      ? 'bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30 dark:text-foreground'
                      : 'dark:text-muted-foreground',
                  )}
                  aria-pressed={activeFilter === option.value}
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
                    : editionController.canUseHumanContact() && activeFilter === 'contact'
                      ? 'Talk to a human requests will appear here after someone asks for follow-up.'
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
              <>
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
                {isLoading ? (
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
              </>
            ) : null}
            {activeFilter === 'chat' ? (
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
                ) : (
                  <HistoryTable
                    items={conversations.map((conversation) => ({
                      kind: 'chat',
                      id: conversation.id,
                      sortAt: conversation.updatedAt,
                      conversation,
                    }))}
                    emptyMessage="No saved chats on this page."
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
              </section>
            ) : null}
            {activeFilter === 'search' ? (
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
              </section>
            ) : null}
            {editionController.canUseHumanContact() && activeFilter === 'contact' ? (
              <section className="space-y-3">
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
                {isLoading ? (
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
                    emptyMessage="No saved Talk to a human requests on this page."
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
              </section>
            ) : null}
          </div>
        )}
    </DashboardPage>
  )
}
