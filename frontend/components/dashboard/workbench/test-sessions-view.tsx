'use client'

import { useEffect, useState } from 'react'

import {
  DashboardTable,
  DashboardTableBody,
  DashboardTableCell,
  DashboardTableHead,
  DashboardTableHeader,
  DashboardTableRow,
} from '@/components/dashboard/shared/dashboard-table'
import { LogoSpinner } from '@/components/ui/spinner'
import { chatApi, type ChatConversationSummary } from '@/lib/api'
import { ConversationDrawer } from '@/components/dashboard/conversation-drawer'
import type { SelectedHistoryItem } from '@/components/dashboard/history/history-list'

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const TEST_SESSION_LIMIT = 100

/**
 * Past operator test chats, shown as the same activity-style table (opening the
 * shared ConversationDrawer for review + turn diagnostics). Test chats are
 * excluded from Activity, so the workbench's History mode is their home. Scoped
 * to `operator_test` and, when known, the current agent.
 */
export function TestSessionsView({ agentId }: { agentId?: string }) {
  const [sessions, setSessions] = useState<ChatConversationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<SelectedHistoryItem>(null)

  useEffect(() => {
    let cancelled = false
    void chatApi
      .listChatHistory({ sourceScope: 'operator_test', limit: TEST_SESSION_LIMIT })
      .then((response) => {
        if (cancelled) {
          return
        }
        const items = agentId
          ? response.conversations.filter((conversation) => conversation.agentId === agentId)
          : response.conversations
        setSessions(items)
      })
      .catch(() => {
        if (!cancelled) {
          setError('Could not load test sessions.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  return (
    <div>
      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="status">
          {error}
        </p>
      ) : sessions === null ? (
        <div className="flex justify-center p-10">
          <LogoSpinner imageClassName="h-7 w-7" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No test sessions yet. Chats you run here are saved as test sessions — kept out of Activity so
          they don&apos;t mix with real end-user conversations.
        </div>
      ) : (
        <DashboardTable minWidth="min-w-0">
          <DashboardTableHead>
            <DashboardTableHeader>Session</DashboardTableHeader>
            <DashboardTableHeader className="w-32">Messages</DashboardTableHeader>
            <DashboardTableHeader className="w-48">Updated</DashboardTableHeader>
          </DashboardTableHead>
          <DashboardTableBody>
            {sessions.map((session) => (
              <DashboardTableRow key={session.id}>
                <DashboardTableCell>
                  <button
                    type="button"
                    onClick={() => setSelectedItem({ kind: 'chat', id: session.id })}
                    className="block max-w-full text-left text-sm font-medium leading-5 text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <span className="block truncate">{session.preview || 'Untitled test session'}</span>
                  </button>
                </DashboardTableCell>
                <DashboardTableCell className="w-32 text-sm text-muted-foreground">
                  {session.messageCount} message{session.messageCount === 1 ? '' : 's'}
                </DashboardTableCell>
                <DashboardTableCell className="w-48 text-sm text-muted-foreground">
                  {timestampFormatter.format(new Date(session.updatedAt))}
                </DashboardTableCell>
              </DashboardTableRow>
            ))}
          </DashboardTableBody>
        </DashboardTable>
      )}

      <ConversationDrawer selectedItem={selectedItem} onSelectedItemChange={setSelectedItem} />
    </div>
  )
}
