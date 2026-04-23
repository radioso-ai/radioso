'use client'

import { useEffect, useRef, useState } from 'react'

import { Send, Sparkles, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ChatMessageThread } from '@/components/dashboard/chat-message-thread'
import { AnonymousChatProvider, useAnonymousChat } from '@/lib/anonymous-chat-context'
import {
  buildWebsiteEmbedCssVars,
  formatWebsiteEmbedDisclaimer,
  formatWebsiteEmbedStartingMessage,
  formatWebsiteEmbedRateLimitRetry,
  getWebsiteEmbedCopy,
  getWebsiteEmbedTheme,
  type WebsiteEmbedCopyOverrides,
  type WebsiteEmbedThemeOverrides,
} from '@/lib/embed-widget'

function AssistantAvatar({
  avatarUrl,
  label,
  themeOverrides,
  className = 'size-10',
}: {
  avatarUrl?: string | null
  label: string
  themeOverrides?: WebsiteEmbedThemeOverrides | null
  className?: string
}) {
  const theme = getWebsiteEmbedTheme(themeOverrides)

  return (
    <Avatar
      className={`${className} border`}
      style={{
        borderColor: theme.panelBorder,
        background: theme.mutedBackground,
        color: theme.accent,
      }}
    >
      {avatarUrl ? <AvatarImage src={avatarUrl} alt={label} /> : null}
      <AvatarFallback
        style={{
          background: theme.mutedBackground,
          color: theme.accent,
        }}
      >
        <Sparkles className="size-4" />
      </AvatarFallback>
    </Avatar>
  )
}

function ChatUnavailable({
  localeOverride,
  avatarUrl,
  copyOverrides,
  themeOverrides,
}: {
  localeOverride?: string | null
  avatarUrl?: string | null
  copyOverrides?: WebsiteEmbedCopyOverrides | null
  themeOverrides?: WebsiteEmbedThemeOverrides | null
}) {
  const copy = getWebsiteEmbedCopy(localeOverride, copyOverrides)
  const theme = getWebsiteEmbedTheme(themeOverrides)

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6 text-center" style={{ color: theme.panelForeground }}>
      <div className="mb-4">
        <AssistantAvatar avatarUrl={avatarUrl} label={copy.embeddedChatTitle} themeOverrides={themeOverrides} className="size-12" />
      </div>
      <h1 className="text-lg font-medium">{copy.publicChatUnavailableTitle}</h1>
      <p className="mt-1 max-w-sm text-sm" style={{ color: theme.mutedForeground }}>
        {copy.publicChatUnavailableMessage}
      </p>
    </div>
  )
}

function RateLimitBanner({
  copy,
  message,
  retryAfterSeconds,
  themeOverrides,
}: {
  copy: ReturnType<typeof getWebsiteEmbedCopy>
  message: string
  retryAfterSeconds: number
  themeOverrides?: WebsiteEmbedThemeOverrides | null
}) {
  const [remaining, setRemaining] = useState(retryAfterSeconds)
  const theme = getWebsiteEmbedTheme(themeOverrides)

  useEffect(() => {
    const interval = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          window.clearInterval(interval)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => window.clearInterval(interval)
  }, [retryAfterSeconds])

  if (remaining <= 0) return null

  return (
    <div
      className="mx-auto max-w-3xl rounded-lg border px-4 py-2 text-sm"
      style={{
        borderColor: theme.panelBorder,
        background: theme.mutedBackground,
        color: theme.panelForeground,
      }}
    >
      {message} {formatWebsiteEmbedRateLimitRetry(copy, remaining)}
    </div>
  )
}

function PublicChatContent({
  initialWorkspaceName,
  localeOverride,
  onStartNewChat,
  onRequestCollapse,
  avatarUrl,
  copyOverrides,
  themeOverrides,
}: {
  initialWorkspaceName?: string | null
  localeOverride?: string | null
  onStartNewChat?: () => Promise<void>
  onRequestCollapse?: () => void
  avatarUrl?: string | null
  copyOverrides?: WebsiteEmbedCopyOverrides | null
  themeOverrides?: WebsiteEmbedThemeOverrides | null
}) {
  const copy = getWebsiteEmbedCopy(localeOverride, copyOverrides)
  const theme = getWebsiteEmbedTheme(themeOverrides)
  const [input, setInput] = useState('')
  const {
    messages,
    workspaceName,
    isLoading,
    isHydrating,
    isLoadingOlderMessages,
    isUnavailable,
    hasOlderMessages,
    rateLimitError,
    retryAfterSeconds,
    loadOlderMessages,
    sendMessage,
    startNewChat,
  } = useAnonymousChat()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const resolvedWorkspaceName = workspaceName ?? initialWorkspaceName ?? copy.embeddedChatTitle

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [isLoading, messages])

  useEffect(() => {
    if (!workspaceName) {
      return
    }

    document.title = workspaceName
  }, [workspaceName])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (!input.trim() || isLoading) return

    const nextInput = input.trim()
    setInput('')
    await sendMessage(nextInput, { method: 'typed' })
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSubmit(event)
    }
  }

  const handleSuggestionSelect = (text: string, messageId: string) => {
    if (isLoading) return
    void sendMessage(text, {
      method: 'suggestion_click',
      suggestionSourceMessageId: messageId,
    })
  }

  const handleStartNewChat = async () => {
    setInput('')
    if (onStartNewChat) {
      await onStartNewChat()
      return
    }

    await startNewChat()
  }

  if (isHydrating) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Spinner className="h-6 w-6" />
        <p className="max-w-sm text-sm" style={{ color: theme.mutedForeground }}>
          {formatWebsiteEmbedStartingMessage({
            embeddedChatStartingMessage: copy.embeddedChatStartingMessage,
            embeddedChatTitle: resolvedWorkspaceName,
          })}
        </p>
      </div>
    )
  }

  if (isUnavailable) {
    return (
      <ChatUnavailable
        localeOverride={localeOverride}
        avatarUrl={avatarUrl}
        copyOverrides={copyOverrides}
        themeOverrides={themeOverrides}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{ color: theme.panelForeground }}>
      <div
        className="shrink-0 border-b px-6 py-4"
        style={{
          borderColor: theme.panelBorder,
          background: theme.panelBackground,
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <AssistantAvatar avatarUrl={avatarUrl} label={resolvedWorkspaceName} themeOverrides={themeOverrides} />
            <div>
              <h1 className="text-lg font-medium">{resolvedWorkspaceName}</h1>
              {copy.publicChatSubtitle.trim() ? (
                <p className="text-sm" style={{ color: theme.mutedForeground }}>
                  {copy.publicChatSubtitle}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-1 self-start">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void handleStartNewChat()}
              disabled={isLoading || isHydrating || isLoadingOlderMessages}
              className="h-8 px-2 text-xs hover:opacity-90"
              style={{ color: theme.mutedForeground }}
            >
              {copy.publicChatNewChatLabel}
            </Button>
            {onRequestCollapse ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={onRequestCollapse}
                className="hover:opacity-90"
                style={{ color: theme.mutedForeground }}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">{copy.publicChatCollapseLabel}</span>
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto p-6"
        style={{ background: theme.panelBackground }}
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4">
              <AssistantAvatar avatarUrl={avatarUrl} label={copy.publicChatEmptyTitle} themeOverrides={themeOverrides} className="size-12" />
            </div>
            <h2 className="mb-1 text-lg font-medium">{copy.publicChatEmptyTitle}</h2>
            <p className="max-w-sm text-sm" style={{ color: theme.mutedForeground }}>
              {copy.publicChatEmptyMessage}
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {hasOlderMessages ? (
              <div className="flex justify-center">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void loadOlderMessages()}
                  disabled={isLoadingOlderMessages}
                  className="hover:opacity-90"
                  style={{
                    borderColor: theme.panelBorder,
                    background: theme.mutedBackground,
                    color: theme.panelForeground,
                  }}
                >
                  {isLoadingOlderMessages ? <Spinner className="mr-2 h-4 w-4" /> : null}
                  {copy.publicChatLoadOlderMessages}
                </Button>
              </div>
            ) : null}
            <ChatMessageThread
              messages={messages}
              onOpenDocument={async () => 'unavailable'}
              onSuggestionSelect={handleSuggestionSelect}
              assistantAvatarUrl={avatarUrl}
              assistantAvatarLabel={resolvedWorkspaceName}
              theme={theme}
            />
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {rateLimitError && retryAfterSeconds ? (
        <div className="shrink-0 px-4 pb-2">
          <RateLimitBanner
            key={retryAfterSeconds}
            copy={copy}
            message={rateLimitError}
            retryAfterSeconds={retryAfterSeconds}
            themeOverrides={themeOverrides}
          />
        </div>
      ) : null}

      <div
        className="shrink-0 border-t p-4"
        style={{
          borderColor: theme.panelBorder,
          background: theme.panelBackground,
        }}
      >
        <form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl items-end gap-3">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={copy.startPrompt}
            className="min-h-[44px] max-h-32 resize-none placeholder:text-[var(--radioso-input-placeholder)]"
            style={{
              background: theme.inputBackground,
              borderColor: theme.inputBorder,
              color: theme.inputForeground,
            }}
          />
          <Button
            type="submit"
            size="icon"
            className="h-[44px] w-[44px] shrink-0 hover:opacity-90"
            disabled={isLoading || !input.trim()}
            style={{
              background: theme.accent,
              color: theme.accentForeground,
            }}
          >
            <Send className="h-4 w-4" />
            <span className="sr-only">{copy.publicChatSendMessageLabel}</span>
          </Button>
        </form>
        <div className="mx-auto mt-3 flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs" style={{ color: theme.mutedForeground }}>
            {formatWebsiteEmbedDisclaimer(copy, resolvedWorkspaceName)}
          </p>
        </div>
      </div>
    </div>
  )
}

export function PublicChatShell({
  token,
  initialWorkspaceName,
  localeOverride,
  onStartNewChat,
  onRequestCollapse,
  avatarUrl,
  copyOverrides,
  themeOverrides,
}: {
  token: string
  initialWorkspaceName?: string | null
  localeOverride?: string | null
  onStartNewChat?: () => Promise<void>
  onRequestCollapse?: () => void
  avatarUrl?: string | null
  copyOverrides?: WebsiteEmbedCopyOverrides | null
  themeOverrides?: WebsiteEmbedThemeOverrides | null
}) {
  const theme = getWebsiteEmbedTheme(themeOverrides)

  return (
    <AnonymousChatProvider token={token} localeOverride={localeOverride}>
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        style={{
          ...buildWebsiteEmbedCssVars(theme),
          background: theme.panelBackground,
          color: theme.panelForeground,
        }}
      >
        <PublicChatContent
          initialWorkspaceName={initialWorkspaceName}
          localeOverride={localeOverride}
          onStartNewChat={onStartNewChat}
          onRequestCollapse={onRequestCollapse}
          avatarUrl={avatarUrl}
          copyOverrides={copyOverrides}
          themeOverrides={themeOverrides}
        />
      </div>
    </AnonymousChatProvider>
  )
}
