import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { DocumentList } from '@/components/dashboard/documents/document-list'
import { HistoryList, type HistoryListItem } from '@/components/dashboard/history/history-list'
import { DashboardPaginatedContent } from '@/components/dashboard/shared/dashboard-paginated-content'
import type { ChatConversationSummary, DocumentSummary } from '@/lib/api'
import type { DashboardRouteState } from '@/lib/dashboard-routes'
import type { WorkspaceOnboardingState } from '@/lib/onboarding'

const routeState: DashboardRouteState = {
  section: 'knowledge',
  workspaceId: 'workspace-1',
}

const onboarding = {
  isImportingSampleDocs: false,
  hasReadyDocuments: true,
} as WorkspaceOnboardingState

const document: DocumentSummary = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Existing document',
  status: 'ready',
  ragStatus: 'processed',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  metadata: {},
  sourceKind: 'inline_text',
}

const conversation: ChatConversationSummary = {
  id: '22222222-2222-2222-2222-222222222222',
  agentId: null,
  agentName: 'Support agent',
  sourceChannel: null,
  sourceOrigin: null,
  anonymousSessionId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  preview: 'Existing conversation',
}

describe('paginated list loading states', () => {
  it('standardizes the dimmed refresh wrapper', () => {
    const markup = renderToStaticMarkup(
      <DashboardPaginatedContent as="section" className="space-y-4" isRefreshing>
        <table><tbody><tr><td>Current row</td></tr></tbody></table>
      </DashboardPaginatedContent>,
    )

    expect(markup).toContain('<section')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('transition-opacity')
    expect(markup).toContain('opacity-60')
    expect(markup).toContain('Current row')
  })

  it('keeps document rows mounted and dimmed while loading another page', () => {
    const markup = renderToStaticMarkup(
      <DocumentList
        isLoading
        totalDocuments={75}
        documents={[document]}
        pageSize={50}
        currentPage={2}
        hasNextPage={false}
        accountId="account-1"
        routeState={routeState}
        onboarding={onboarding}
        deleteErrorById={{}}
        retryErrorById={{}}
        deletingDocumentId={null}
        retryingDocumentId={null}
        formatDate={() => 'Jan 2, 2026'}
        onPreviousPage={vi.fn()}
        onNextPage={vi.fn()}
        onOpenDocument={vi.fn()}
        onOpenImport={vi.fn()}
        onOpenCreate={vi.fn()}
        onDelete={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain('Existing document')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('opacity-60')
    expect(markup).not.toContain('aria-label="Loading"')
  })

  it('keeps activity rows mounted and dimmed while loading another page', () => {
    const allHistoryItems: HistoryListItem[] = [{
      kind: 'chat',
      id: conversation.id,
      sortAt: conversation.updatedAt,
      conversation,
    }]

    const markup = renderToStaticMarkup(
      <HistoryList
        accountId="account-1"
        workspaceId="workspace-1"
        routeState={{ ...routeState, section: 'activity' }}
        onboarding={onboarding}
        filter="all"
        isLoading
        hasAnyHistory
        listError={null}
        pageSize={50}
        conversations={[]}
        conversationTotal={0}
        conversationPage={1}
        conversationTotalPages={1}
        searches={[]}
        searchTotal={0}
        searchPage={1}
        searchTotalPages={1}
        contacts={[]}
        contactTotal={0}
        contactPage={1}
        contactTotalPages={1}
        allHistoryItems={allHistoryItems}
        allTotal={75}
        allPage={2}
        allTotalPages={2}
        onFilterChange={vi.fn()}
        onSelectItem={vi.fn()}
        onConversationPageChange={vi.fn()}
        onSearchPageChange={vi.fn()}
        onContactPageChange={vi.fn()}
        onAllPageChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    )

    expect(markup).toContain('Existing conversation')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('opacity-60')
    expect(markup).not.toContain('aria-label="Loading"')
  })
})
