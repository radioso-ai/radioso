'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  type ChatConversationDetail,
  type ChatConversationSummary,
  chatApi,
} from '@/lib/api'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { Spinner } from '@/components/ui/spinner'
import { MessageSquareText, X } from 'lucide-react'

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

  const selectedSummary = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  )

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
          }
        }}
        direction="right"
      >
        <DrawerContent className="h-full w-full max-w-3xl">
          <DrawerHeader className="border-b border-border">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <DrawerTitle>{selectedSummary?.preview || 'Conversation details'}</DrawerTitle>
                <DrawerDescription className="sr-only">Conversation details panel</DrawerDescription>
              </div>
              <DrawerClose className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </DrawerClose>
            </div>
          </DrawerHeader>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {isDetailLoading ? (
              <div className="flex h-full items-center justify-center">
                <Spinner className="h-6 w-6" />
              </div>
            ) : detailError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {detailError}
              </div>
            ) : conversationDetail ? (
              <div className="space-y-6">
                <div className="space-y-1 text-sm text-muted-foreground">
                  <p>
                    Conversation{' '}
                    <span className="select-all font-mono text-foreground">{conversationDetail.conversationId}</span>
                  </p>
                  <p>
                    Account{' '}
                    <span className="select-all font-mono text-foreground">{conversationDetail.accountId}</span>
                  </p>
                </div>

                <div className="space-y-4">
                  {conversationDetail.messages.map((message, index) => {
                    const previousMessage = index > 0 ? conversationDetail.messages[index - 1] : null
                    const responseTimeMs =
                      message.role === 'assistant' && previousMessage
                        ? new Date(message.createdAt).getTime() - new Date(previousMessage.createdAt).getTime()
                        : null

                    return (
                      <div
                        key={message.id}
                        className={`rounded-xl border p-4 ${
                          message.role === 'user'
                            ? 'border-primary/25 bg-primary/5'
                            : 'border-border bg-card'
                        }`}
                      >
                        <div className="mb-2 flex items-center justify-between gap-4">
                          <div>
                            <p className="text-sm font-medium capitalize text-foreground">{message.role}</p>
                            <p className="text-xs text-muted-foreground">{formatTimestamp(message.createdAt)}</p>
                          </div>
                          <p className="select-all font-mono text-xs text-muted-foreground">{message.id}</p>
                        </div>

                        <p className="whitespace-pre-wrap text-sm text-foreground">{message.content}</p>

                        {message.role === 'assistant' ? (
                          <AssistantDebugSection debug={message.debug} responseTimeMs={responseTimeMs} />
                        ) : null}
                      </div>
                    )
                  })}
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

function MetadataCard({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-sm text-foreground ${mono ? 'font-mono break-all' : ''}`}>{value}</p>
    </div>
  )
}

const formatResponseTime = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function AssistantDebugSection({
  debug,
  responseTimeMs,
}: {
  debug: ChatConversationDetail['messages'][number]['debug']
  responseTimeMs: number | null
}) {
  if (!debug) {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        Debug metadata unavailable for this assistant turn.
      </div>
    )
  }

  const retrievalInfo = debug.retrievalInfo

  return (
    <details className="mt-4 rounded-lg border border-border/70 bg-background/70 p-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer list-none font-medium text-foreground">
        Debug metadata
      </summary>

      <div className="mt-3 space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <MetadataCard label="Status" value={debug.eventStatus} />
          <MetadataCard label="Recorded" value={formatTimestamp(debug.recordedAt)} />
          <MetadataCard label="Streamed" value={debug.stream ? 'Yes' : 'No'} />
          <MetadataCard label="Citations" value={String(debug.citationCount)} />
          {responseTimeMs !== null && responseTimeMs > 0 ? (
            <MetadataCard label="Response time" value={formatResponseTime(responseTimeMs)} />
          ) : null}
        </div>

        {debug.errorMessage ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive">
            {debug.errorMessage}
          </div>
        ) : null}

        {retrievalInfo?.parsedQuery ? (
          <div className="space-y-1">
            <p className="font-medium text-foreground">Parsed query</p>
            <p>Semantic: {retrievalInfo.parsedQuery.semanticQuery || 'None'}</p>
            <p>Lexical: {retrievalInfo.parsedQuery.lexicalQuery || 'None'}</p>
            <p>
              Constraints:{' '}
              {retrievalInfo.parsedQuery.constraintSummary.length > 0
                ? retrievalInfo.parsedQuery.constraintSummary.join(', ')
                : 'None'}
            </p>
          </div>
        ) : null}

        {retrievalInfo ? (
          <>
            <div className="space-y-1">
              <p className="font-medium text-foreground">Candidate counts</p>
              <p>
                Semantic {retrievalInfo.candidateCounts.semantic} · Lexical {retrievalInfo.candidateCounts.lexical}
                {' · '}Merged {retrievalInfo.candidateCounts.merged} · Final {retrievalInfo.candidateCounts.final}
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-medium text-foreground">Retrieval status</p>
              <p>Rerank: {retrievalInfo.rerankStatus}</p>
              <p>Fallback applied: {retrievalInfo.fallbackApplied ? 'Yes' : 'No'}</p>
            </div>

            <div className="space-y-1">
              <p className="font-medium text-foreground">Applied constraints</p>
              {retrievalInfo.appliedConstraints?.length ? (
                <div className="space-y-1">
                  {retrievalInfo.appliedConstraints.map((constraint, index) => (
                    <p key={`${constraint.family}-${constraint.summary}-${index}`}>
                      {constraint.family}: {constraint.summary} ({constraint.mode}, {constraint.outcome})
                    </p>
                  ))}
                </div>
              ) : (
                <p>No supported constraints were applied.</p>
              )}
            </div>
          </>
        ) : null}
      </div>
    </details>
  )
}
