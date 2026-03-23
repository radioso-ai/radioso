'use client'

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import {
  type ChatConversationDetail,
  type ChatConversationSummary,
  type ChatConversationTurn,
  chatApi,
  documentsApi,
} from '@/lib/api'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
} from '@/components/ui/drawer'
import { ActionButton } from '@/components/ui/action-button'
import { Spinner } from '@/components/ui/spinner'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { MessageSquareText, X } from 'lucide-react'
import { ChatRetrievalInfo } from './chat-retrieval-info'
import { ChatRetrievalTraceGraph } from './chat-retrieval-trace-graph'
import { ChatMessageThread } from './chat-message-thread'
import type { CitationOpenResult } from './chat-citations'

const formatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
})

const formatTimestamp = (value: string) => formatter.format(new Date(value))

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  ) {
    return error.error.message
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

export function ChatHistoryView({ accountId }: { accountId: string }) {
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([])
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [conversationDetail, setConversationDetail] = useState<ChatConversationDetail | null>(null)
  const [isListLoading, setIsListLoading] = useState(true)
  const [isDetailLoading, setIsDetailLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [selectedThreadMessageId, setSelectedThreadMessageId] = useState<string | null>(null)
  const [selectedAssistantMessageId, setSelectedAssistantMessageId] = useState<string | null>(null)
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(undefined)
  const [showGraph, setShowGraph] = useState(false)

  const loadConversations = useCallback(async () => {
    setIsListLoading(true)
    setListError(null)

    try {
      const nextConversations = await chatApi.listHistory()
      setConversations(nextConversations)
    } catch (error) {
      setListError(getErrorMessage(error, 'Failed to load chat history.'))
    } finally {
      setIsListLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConversations()
  }, [loadConversations, accountId])

  useEffect(() => {
    if (!selectedConversationId) {
      setConversationDetail(null)
      setDetailError(null)
      return
    }

    let isActive = true

    const loadConversation = async () => {
      setIsDetailLoading(true)
      setDetailError(null)

      try {
        const detail = await chatApi.getHistoryConversation(selectedConversationId)
        if (!isActive) {
          return
        }
        setConversationDetail(detail)
      } catch (error) {
        if (!isActive) {
          return
        }
        setConversationDetail(null)
        setDetailError(getErrorMessage(error, 'Failed to load conversation details.'))
      } finally {
        if (isActive) {
          setIsDetailLoading(false)
        }
      }
    }

    void loadConversation()

    return () => {
      isActive = false
    }
  }, [selectedConversationId])

  const assistantMessages = useMemo(
    () => conversationDetail?.messages.filter((message) => message.role === 'assistant') ?? [],
    [conversationDetail],
  )

  const selectedThreadMessage = useMemo(
    () => conversationDetail?.messages.find((message) => message.id === selectedThreadMessageId) ?? null,
    [conversationDetail, selectedThreadMessageId],
  )

  const selectedAssistantMessage = useMemo(
    () =>
      assistantMessages.find((message) => message.id === selectedAssistantMessageId) ??
      assistantMessages[assistantMessages.length - 1] ??
      null,
    [assistantMessages, selectedAssistantMessageId],
  )

  const selectedDiagnosticsAssistantMessage = useMemo(() => {
    if (!conversationDetail || !selectedThreadMessage) {
      return selectedAssistantMessage
    }

    if (selectedThreadMessage.role === 'assistant') {
      return selectedThreadMessage
    }

    const messageIndex = conversationDetail.messages.findIndex((message) => message.id === selectedThreadMessage.id)
    if (messageIndex < 0) {
      return null
    }

    return (
      conversationDetail.messages
        .slice(messageIndex + 1)
        .find((message) => message.role === 'assistant') ?? null
    )
  }, [conversationDetail, selectedThreadMessage, selectedAssistantMessage])

  const selectedDiagnosticsDebug =
    selectedDiagnosticsAssistantMessage?.role === 'assistant' ? selectedDiagnosticsAssistantMessage.debug : undefined
  const selectedDiagnosticsTrace = selectedDiagnosticsDebug?.retrievalTrace
  const selectedDiagnosticsTraceId = selectedDiagnosticsTrace?.traceId
  const selectedDiagnosticsInitialStageId = selectedDiagnosticsTrace?.stages[0]?.stageId

  useEffect(() => {
    if (!conversationDetail) {
      setSelectedThreadMessageId(null)
      setSelectedAssistantMessageId(null)
      setSelectedStageId(undefined)
      setShowGraph(false)
      return
    }

    const traceBearingMessage =
      [...conversationDetail.messages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.debug) ?? null

    setSelectedThreadMessageId(traceBearingMessage?.id ?? null)
    setSelectedAssistantMessageId(traceBearingMessage?.id ?? null)
    setSelectedStageId(traceBearingMessage?.debug?.retrievalTrace?.stages[0]?.stageId)
    setShowGraph(false)
  }, [conversationDetail])

  useEffect(() => {
    setSelectedStageId(selectedDiagnosticsInitialStageId)
  }, [selectedDiagnosticsTraceId, selectedDiagnosticsInitialStageId])

  const handleSelectThreadMessage = useCallback(
    (messageId: string) => {
      if (!conversationDetail) {
        return
      }

      const messageIndex = conversationDetail.messages.findIndex((message) => message.id === messageId)
      if (messageIndex < 0) {
        return
      }

      const clickedMessage = conversationDetail.messages[messageIndex]
      setSelectedThreadMessageId(clickedMessage.id)

      const targetAssistant =
        clickedMessage.role === 'assistant'
          ? clickedMessage
          : conversationDetail.messages
              .slice(messageIndex + 1)
              .find((message) => message.role === 'assistant')

      if (!targetAssistant || targetAssistant.role !== 'assistant') {
        return
      }

      setSelectedAssistantMessageId(targetAssistant.id)
      setSelectedStageId(targetAssistant.debug?.retrievalTrace?.stages[0]?.stageId)
    },
    [conversationDetail],
  )

  const handleOpenCitation = useCallback(async (documentId: string): Promise<CitationOpenResult> => {
    try {
      await documentsApi.getDocument(documentId)
      return 'opened'
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'error' in error &&
        error.error &&
        typeof error.error === 'object' &&
        'code' in error.error &&
        error.error.code === 'not_found'
      ) {
        return 'unavailable'
      }

      return 'error'
    }
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium text-foreground">Chat History</h1>
        <p className="text-sm text-muted-foreground">
          Review saved conversations and inspect their debug metadata.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {isListLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : listError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {listError}
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <MessageSquareText className="h-5 w-5 text-primary" />
            </div>
            <h2 className="text-lg font-medium text-foreground">No chat history yet</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Conversations will appear here after this account starts using chat.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-3">
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => setSelectedConversationId(conversation.id)}
                className="w-full rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:bg-accent/40"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">{conversation.preview || 'Untitled conversation'}</p>
                    <p className="text-xs text-muted-foreground">{conversation.id}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Updated {formatTimestamp(conversation.updatedAt)}
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {conversation.sourceChannel === 'anonymous' && (
                    <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-amber-700 dark:text-amber-400">
                      Anonymous
                    </span>
                  )}
                  <span className="rounded-full bg-muted px-2.5 py-1">
                    {conversation.messageCount} messages
                  </span>
                  <span className="rounded-full bg-muted px-2.5 py-1">
                    {conversation.userMessageCount} user
                  </span>
                  <span className="rounded-full bg-muted px-2.5 py-1">
                    {conversation.assistantMessageCount} assistant
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <Drawer
        open={selectedConversationId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedConversationId(null)
            setShowGraph(false)
          }
        }}
        direction="right"
        handleOnly
      >
        <DrawerContent
          className={`h-full transition-[width,max-width] duration-300 ease-in-out data-[vaul-drawer-direction=right]:w-[96vw] sm:data-[vaul-drawer-direction=right]:max-w-[96vw] ${
            showGraph
              ? 'lg:data-[vaul-drawer-direction=right]:w-[94vw] lg:data-[vaul-drawer-direction=right]:max-w-[94vw]'
              : 'lg:data-[vaul-drawer-direction=right]:w-[88vw] lg:data-[vaul-drawer-direction=right]:max-w-[88vw]'
          }`}
        >
          <DrawerHeader className="border-b border-border">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                {selectedConversationId ? (
                  <CopyValueField
                    label="Conversation ID:"
                    value={selectedConversationId}
                    copyValue={selectedConversationId}
                    ariaLabel="Copy conversation ID"
                    compact
                    wrap
                    fitContent
                    inlineLabel
                  />
                ) : null}
                <DrawerDescription className="sr-only">Conversation details panel</DrawerDescription>
              </div>
              <DrawerClose className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </DrawerClose>
            </div>
          </DrawerHeader>

          <div className="min-h-0 flex-1 overflow-hidden p-4">
            {isDetailLoading ? (
              <div className="flex h-full items-center justify-center">
                <Spinner className="h-6 w-6" />
              </div>
            ) : detailError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {detailError}
              </div>
            ) : conversationDetail ? (
              <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(640px,1.1fr)]">
                <div className="min-h-0 overflow-y-auto pr-1">
                  <ChatMessageThread
                    messages={conversationDetail.messages}
                    onOpenDocument={handleOpenCitation}
                    onMessageSelect={handleSelectThreadMessage}
                    selectedMessageId={selectedThreadMessageId ?? undefined}
                  />
                </div>

                <div className="min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/50 p-4">
                  <DiagnosticsPanel
                    selectedMessage={selectedThreadMessage}
                    diagnosticsMessage={selectedDiagnosticsAssistantMessage}
                    showGraph={showGraph}
                    onShowGraph={() => {
                      if (selectedDiagnosticsAssistantMessage?.debug?.retrievalTrace) {
                        setShowGraph(true)
                      }
                    }}
                    onHideGraph={() => {
                      setShowGraph(false)
                      setSelectedStageId(selectedDiagnosticsInitialStageId)
                    }}
                    selectedStageId={selectedStageId}
                    graphPane={
                      showGraph ? (
                        selectedDiagnosticsTrace ? (
                          <ChatRetrievalTraceGraph
                            retrievalTrace={selectedDiagnosticsTrace}
                            selectedStageId={selectedStageId ?? selectedDiagnosticsTrace.stages[0]?.stageId ?? ''}
                            onSelectStage={setSelectedStageId}
                          />
                        ) : (
                          <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                            Detailed retrieval trace unavailable for this assistant turn.
                          </div>
                        )
                      ) : null
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select a conversation to inspect it.
              </div>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

function DiagnosticsPanel({
  selectedMessage,
  diagnosticsMessage,
  showGraph,
  onShowGraph,
  onHideGraph,
  selectedStageId,
  graphPane,
}: {
  selectedMessage: ChatConversationTurn | null
  diagnosticsMessage: ChatConversationTurn | null
  showGraph: boolean
  onShowGraph: () => void
  onHideGraph: () => void
  selectedStageId?: string
  graphPane: ReactNode
}) {
  if (!selectedMessage) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        Select a message to inspect diagnostics.
      </div>
    )
  }

  const diagnosticsDebug =
    diagnosticsMessage?.role === 'assistant' ? diagnosticsMessage.debug : undefined
  const hasDiagnostics = Boolean(diagnosticsDebug)

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <p className="pt-2 text-sm font-medium text-foreground whitespace-nowrap">Message ID:</p>
          <div className="min-w-0 flex-1">
            <CopyValueField
              value={selectedMessage.id}
              copyValue={selectedMessage.id}
              ariaLabel={`Copy ${selectedMessage.role} message ID`}
              compact
              wrap
            />
          </div>
        </div>

        {diagnosticsDebug?.retrievalTrace ? (
          <div className="shrink-0">
            <ActionButton
              type="button"
              size="sm"
              theme="yellow"
              className="h-9 px-4 text-sm"
              onClick={showGraph ? onHideGraph : onShowGraph}
            >
              {showGraph ? 'Hide graph' : 'Show graph'}
            </ActionButton>
          </div>
        ) : null}
      </div>

      {!hasDiagnostics ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          No diagnostics are available for this message yet.
        </div>
      ) : null}

      {diagnosticsDebug?.errorMessage ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {diagnosticsDebug.errorMessage}
        </div>
      ) : null}

      {hasDiagnostics ? (
        <div
          className="grid gap-4 overflow-hidden"
          style={{
            gridTemplateColumns: showGraph ? 'minmax(380px,1fr) minmax(0,1.1fr)' : '0px minmax(0,1fr)',
            transition: 'grid-template-columns 300ms ease',
          }}
        >
        <div
          className="overflow-hidden rounded-xl border border-border/70 bg-background/60 p-4"
          style={{
            opacity: showGraph ? 1 : 0,
            transform: showGraph ? 'translateX(0)' : 'translateX(12px)',
            transition: 'opacity 300ms ease, transform 300ms ease',
            pointerEvents: showGraph ? 'auto' : 'none',
          }}
        >
            <div className="mb-3">
              <p className="text-sm font-medium text-foreground">Trace graph</p>
              <p className="text-xs text-muted-foreground">
                Top-down retrieval flow for the selected assistant turn.
              </p>
            </div>
            {graphPane}
          </div>

        <div>
        {showGraph ? (
          <ChatRetrievalInfo
            retrievalInfo={diagnosticsDebug?.retrievalInfo}
            retrievalTrace={diagnosticsDebug?.retrievalTrace}
            selectedStageId={selectedStageId}
            graphMode
          />
        ) : (
          <ChatRetrievalInfo
            retrievalInfo={diagnosticsDebug?.retrievalInfo}
            retrievalTrace={diagnosticsDebug?.retrievalTrace}
            selectedStageId={undefined}
          />
        )}
        </div>
        </div>
      ) : null}
    </div>
  )
}
