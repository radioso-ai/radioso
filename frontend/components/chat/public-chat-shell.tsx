'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { MoreHorizontal, RotateCcw, UserRound, X } from 'lucide-react'

import {
  AssistantAvatar,
  PublicChatBubbleComposerForm,
  PublicChatBubbleComposerSurface,
  PublicChatBubbleDisclaimer,
  PublicChatBubbleHeader,
  PublicChatBubblePoweredBy,
} from '@/components/chat/public-chat-bubble-view'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { ChatMessageThread, type ChatThreadMessage } from '@/components/dashboard/chat-message-thread'
import {
  HumanContactInlineComposer,
  type HumanContactInlineRequest,
} from '@/components/chat/human-contact-inline-composer'
import { AnonymousChatProvider, useAnonymousChat } from '@/lib/anonymous-chat-context'
import {
  answerFeedbackApi,
  type AnswerFeedbackState,
  type AnswerFeedbackValue,
  type ChatSuggestion,
  type HumanContactTriggerSource,
  type WebsiteEmbedPageContext,
} from '@/lib/api'
import { createClientId } from '@/lib/client-id'
import { editionController } from '@/lib/edition-controller'
import { HUMAN_CONTACT_REQUEST_TRIGGER_REASON, isHumanContactRequest } from '@/lib/human-contact-intent'
import {
  buildWebsiteEmbedSurfaceCssVars,
  formatWebsiteEmbedStartingMessage,
  formatWebsiteEmbedRateLimitRetry,
  getWebsiteEmbedCopy,
  getWebsiteEmbedTheme,
  shouldUseWebsiteEmbedCompactKeyboardLayout,
  shouldUseWebsiteEmbedNarrowLayout,
  type WebsiteEmbedCopyOverrides,
  type WebsiteEmbedThemeOverrides,
} from '@/lib/embed-widget'

type PublicChatSurface = 'public' | 'embed'

const isEditableElement = (element: Element | null) => {
  if (!element) {
    return false
  }

  const tagName = element.tagName.toLowerCase()
  return tagName === 'textarea' || tagName === 'input' || (element instanceof HTMLElement && element.isContentEditable)
}

const isTypingControl = (element: EventTarget | null) => {
  if (!(element instanceof Element)) {
    return false
  }

  if (isEditableElement(element)) {
    return true
  }

  const tagName = element.tagName.toLowerCase()
  return tagName === 'button' || tagName === 'a' || tagName === 'select'
}

export function readWebsiteEmbedViewportSnapshot() {
  if (typeof window === 'undefined') {
    return {
      viewportWidth: Number.POSITIVE_INFINITY,
      layoutViewportHeight: Number.POSITIVE_INFINITY,
      visualViewportHeight: null,
      editableFocused: false,
    }
  }

  const visualViewport = window.visualViewport

  return {
    viewportWidth: visualViewport?.width ?? window.innerWidth,
    layoutViewportHeight: window.innerHeight,
    visualViewportHeight: visualViewport?.height ?? null,
    editableFocused: isEditableElement(document.activeElement),
  }
}

function useWebsiteEmbedViewportLayout(enabled: boolean) {
  const [layout, setLayout] = useState({ isCompactKeyboardLayout: false, isNarrowLayout: false })
  const maxLayoutViewportHeightRef = useRef(0)

  useEffect(() => {
    if (!enabled) {
      return
    }

    const update = () => {
      const snapshot = readWebsiteEmbedViewportSnapshot()
      const isNarrowLayout = shouldUseWebsiteEmbedNarrowLayout(snapshot.viewportWidth)

      if (isNarrowLayout && !snapshot.editableFocused) {
        maxLayoutViewportHeightRef.current = Math.max(
          maxLayoutViewportHeightRef.current,
          snapshot.layoutViewportHeight,
        )
      }

      const isCompactKeyboardLayout = shouldUseWebsiteEmbedCompactKeyboardLayout({
        ...snapshot,
        maxLayoutViewportHeight: maxLayoutViewportHeightRef.current || snapshot.layoutViewportHeight,
      })

      if (isNarrowLayout && !isCompactKeyboardLayout) {
        maxLayoutViewportHeightRef.current = Math.max(
          maxLayoutViewportHeightRef.current,
          snapshot.layoutViewportHeight,
        )
      }

      setLayout({ isCompactKeyboardLayout, isNarrowLayout })
    }

    const animationFrame = window.requestAnimationFrame(update)
    window.addEventListener('resize', update)
    window.addEventListener('focusin', update)
    window.addEventListener('focusout', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', update)
      window.removeEventListener('focusin', update)
      window.removeEventListener('focusout', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [enabled])

  return enabled ? layout : { isCompactKeyboardLayout: false, isNarrowLayout: false }
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

function PublicChatActionsMenu({
  copy,
  theme,
  contactAvailable,
  contactDisabled,
  clearDisabled,
  onContact,
  onClear,
  className = 'h-8 w-8 hover:opacity-90',
  iconColor,
}: {
  copy: ReturnType<typeof getWebsiteEmbedCopy>
  theme: ReturnType<typeof getWebsiteEmbedTheme>
  contactAvailable: boolean
  contactDisabled: boolean
  clearDisabled: boolean
  onContact: () => void
  onClear: () => void
  className?: string
  iconColor?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={className}
          style={{ color: iconColor ?? theme.mutedForeground }}
        >
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Chat options</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem
          disabled={clearDisabled}
          onSelect={() => {
            onClear()
          }}
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          {copy.publicChatNewChatLabel}
        </DropdownMenuItem>
        {contactAvailable ? (
          <DropdownMenuItem
            disabled={contactDisabled}
            onSelect={() => {
              onContact()
            }}
          >
            <UserRound className="mr-2 h-4 w-4" />
            Talk to a human
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
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
  surface,
}: {
  initialWorkspaceName?: string | null
  localeOverride?: string | null
  onStartNewChat?: () => Promise<void>
  onRequestCollapse?: () => void
  avatarUrl?: string | null
  copyOverrides?: WebsiteEmbedCopyOverrides | null
  themeOverrides?: WebsiteEmbedThemeOverrides | null
  surface: PublicChatSurface
}) {
  const copy = getWebsiteEmbedCopy(localeOverride, copyOverrides)
  const [input, setInput] = useState('')
  const [contactRequest, setContactRequest] = useState<HumanContactInlineRequest | null>(null)
  const [contactConfirmation, setContactConfirmation] = useState<ChatThreadMessage | null>(null)
  const { isCompactKeyboardLayout, isNarrowLayout } = useWebsiteEmbedViewportLayout(surface === 'embed')
  const {
    publicChatToken,
    conversationId,
    messages,
    workspaceName,
    assistantAvatarUrl,
    assistantTheme,
    publicSessionActions,
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
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const resolvedWorkspaceName = workspaceName ?? initialWorkspaceName ?? copy.embeddedChatTitle
  const resolvedAvatarUrl = assistantAvatarUrl ?? avatarUrl
  const resolvedThemeOverrides = assistantTheme ?? themeOverrides
  const theme = getWebsiteEmbedTheme(resolvedThemeOverrides)
  const contactAction = publicSessionActions.contact
  const contactAvailable =
    editionController.canUseHumanContact() &&
    Boolean(contactAction) &&
    typeof contactAction === 'object' &&
    !Array.isArray(contactAction) &&
    (contactAction as { configured?: unknown }).configured === true
  const latestAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')
  const contactDisabled = isLoading || isHydrating || isLoadingOlderMessages || !conversationId || !latestAssistantMessage
  const clearDisabled = isLoading || isHydrating || isLoadingOlderMessages
  const visibleMessages = contactConfirmation ? [...messages, contactConfirmation] : messages

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    if (messagesScrollRef.current) {
      messagesScrollRef.current.scrollTo({
        top: messagesScrollRef.current.scrollHeight,
        behavior,
      })
      return
    }

    messagesEndRef.current?.scrollIntoView({ behavior })
  }

  useEffect(() => {
    scrollToBottom()
  }, [contactConfirmation, isLoading, messages])

  useEffect(() => {
    if (surface !== 'public' || typeof document === 'undefined') {
      return
    }
    const root = document.documentElement
    const body = document.body
    const previousRootBackground = root.style.background
    const previousBodyBackground = body.style.background
    const previousBodyColor = body.style.color
    root.style.background = theme.panelBackground
    body.style.background = theme.panelBackground
    body.style.color = theme.panelForeground
    return () => {
      root.style.background = previousRootBackground
      body.style.background = previousBodyBackground
      body.style.color = previousBodyColor
    }
  }, [surface, theme.panelBackground, theme.panelForeground])

  useEffect(() => {
    if (!isCompactKeyboardLayout) {
      return
    }

    const scrollNow = () => scrollToBottom('auto')
    const animationFrame = window.requestAnimationFrame(scrollNow)
    const delayedScroll = window.setTimeout(scrollNow, 250)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.clearTimeout(delayedScroll)
    }
  }, [isCompactKeyboardLayout, messages.length])

  useEffect(() => {
    if (!workspaceName) {
      return
    }

    document.title = workspaceName
  }, [workspaceName])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()

    if (!input.trim() || isLoading) return

    const nextInput = input.trim()
    if (editionController.canUseHumanContact() && contactAvailable && conversationId && latestAssistantMessage && isHumanContactRequest(nextInput)) {
      setInput('')
      openContactComposer({
        assistantMessageId: latestAssistantMessage.persistedAssistantMessageId ?? latestAssistantMessage.id,
        triggerSource: 'explicit_user_request',
        triggerReason: HUMAN_CONTACT_REQUEST_TRIGGER_REASON,
      })
      return
    }

    setInput('')
    setContactConfirmation(null)
    await sendMessage(nextInput, { method: 'typed' })
  }

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSubmit(event)
    }
  }

  useEffect(() => {
    if (surface !== 'embed' || isHydrating || isUnavailable) {
      return
    }

    const handleTypingShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key.length !== 1 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTypingControl(event.target)
      ) {
        return
      }

      event.preventDefault()
      const inputNode = inputRef.current
      const selectionStart = inputNode?.selectionStart ?? input.length
      const selectionEnd = inputNode?.selectionEnd ?? input.length
      const nextCursorPosition = selectionStart + event.key.length

      setInput((currentInput) => {
        const start = Math.min(selectionStart, currentInput.length)
        const end = Math.min(Math.max(selectionEnd, start), currentInput.length)
        return `${currentInput.slice(0, start)}${event.key}${currentInput.slice(end)}`
      })

      window.requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.setSelectionRange(nextCursorPosition, nextCursorPosition)
      })
    }

    window.addEventListener('keydown', handleTypingShortcut)
    return () => window.removeEventListener('keydown', handleTypingShortcut)
  }, [input.length, isHydrating, isUnavailable, surface])

  const openContactComposer = (input: {
    assistantMessageId?: string
    triggerSource: HumanContactTriggerSource
    triggerReason?: string
  }) => {
    if (!conversationId || !latestAssistantMessage) {
      return
    }

    setContactConfirmation(null)
    setContactRequest({
      conversationId,
      assistantMessageId: input.assistantMessageId ?? latestAssistantMessage.id,
      triggerSource: input.triggerSource,
      triggerReason: input.triggerReason,
    })
  }

  const handleManualContact = () => {
    if (!latestAssistantMessage) {
      return
    }
    openContactComposer({
      assistantMessageId: latestAssistantMessage.persistedAssistantMessageId ?? latestAssistantMessage.id,
      triggerSource: 'manual',
    })
  }

  const handleSuggestionSelect = (suggestion: ChatSuggestion, messageId: string) => {
    if (isLoading) return

    if (editionController.isHumanContactSuggestion(suggestion)) {
      const payload = suggestion.action.payload ?? {}
      const triggerSource = typeof payload.triggerSource === 'string'
        ? payload.triggerSource as HumanContactTriggerSource
        : 'assistant_suggestion'
      const assistantMessageId = typeof payload.assistantMessageId === 'string'
        ? payload.assistantMessageId
        : messageId
      const triggerReason = typeof payload.triggerReason === 'string' ? payload.triggerReason : undefined
      openContactComposer({ assistantMessageId, triggerSource, triggerReason })
      return
    }

    void sendMessage(suggestion.text, {
      method: 'suggestion_click',
      suggestionSourceMessageId: messageId,
    })
  }

  const handleStartNewChat = async () => {
    setInput('')
    if (onStartNewChat) {
      setContactRequest(null)
      setContactConfirmation(null)
      await onStartNewChat()
      return
    }

    setContactRequest(null)
    setContactConfirmation(null)
    await startNewChat()
  }

  const handleAnswerFeedback = async (input: {
    assistantMessageId: string
    value: AnswerFeedbackValue
    comment?: string | null
  }): Promise<AnswerFeedbackState> => {
    const feedback = await answerFeedbackApi.submitPublic(publicChatToken, input)
    return { value: feedback.value, comment: feedback.comment }
  }

  const handleClearAnswerFeedback = async (assistantMessageId: string) => {
    await answerFeedbackApi.clearPublic(publicChatToken, assistantMessageId)
  }

  const handleContactSubmitted = (content: string) => {
    setContactRequest(null)
    setContactConfirmation({
      id: createClientId('contact-confirmation'),
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
      status: 'complete',
    })
  }

  if (isHydrating) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <LogoSpinner imageClassName="h-7 w-7" />
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
        avatarUrl={resolvedAvatarUrl}
        copyOverrides={copyOverrides}
        themeOverrides={resolvedThemeOverrides}
      />
    )
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      style={{
        ...buildWebsiteEmbedSurfaceCssVars(theme),
        background: theme.panelBackground,
        color: theme.panelForeground,
      }}
    >
      {isCompactKeyboardLayout && onRequestCollapse ? (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
          <PublicChatActionsMenu
            copy={copy}
            theme={theme}
            contactAvailable={contactAvailable}
            contactDisabled={contactDisabled}
            clearDisabled={clearDisabled}
            onContact={handleManualContact}
            onClear={() => void handleStartNewChat()}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onRequestCollapse}
            className="h-8 w-8 hover:opacity-90"
            style={{ color: theme.mutedForeground }}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">{copy.publicChatCollapseLabel}</span>
          </Button>
        </div>
      ) : null}

      {!isCompactKeyboardLayout ? (
        <PublicChatBubbleHeader
          theme={theme}
          themeOverrides={resolvedThemeOverrides}
          workspaceName={resolvedWorkspaceName}
          subtitle={copy.publicChatSubtitle}
          avatarUrl={resolvedAvatarUrl}
          actions={
            <>
              <PublicChatActionsMenu
                copy={copy}
                theme={theme}
                contactAvailable={contactAvailable}
                contactDisabled={contactDisabled}
                clearDisabled={clearDisabled}
                onContact={handleManualContact}
                onClear={() => void handleStartNewChat()}
                iconColor={theme.accentForeground}
              />
              {onRequestCollapse ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={onRequestCollapse}
                  className="h-8 w-8 hover:opacity-90"
                  style={{ color: theme.accentForeground }}
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">{copy.publicChatCollapseLabel}</span>
                </Button>
              ) : null}
            </>
          }
        />
      ) : null}

      <div
        ref={messagesScrollRef}
        className={`radioso-themed-scrollbar min-h-0 flex-1 overflow-y-auto ${
          isCompactKeyboardLayout ? (onRequestCollapse ? 'px-3 pb-3 pt-10' : 'p-3') : 'p-6'
        }`}
        style={{ background: theme.panelBackground }}
      >
        {visibleMessages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4">
              <AssistantAvatar avatarUrl={resolvedAvatarUrl} label={copy.publicChatEmptyTitle} themeOverrides={resolvedThemeOverrides} className="size-12" />
            </div>
            <h2 className="mb-1 text-lg font-medium">{copy.publicChatEmptyTitle}</h2>
            <p className="max-w-sm text-sm" style={{ color: theme.mutedForeground }}>
              {copy.publicChatEmptyMessage}
            </p>
          </div>
        ) : (
          <div className={`mx-auto max-w-3xl ${isCompactKeyboardLayout ? 'space-y-4' : 'space-y-6'}`}>
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
              messages={visibleMessages}
              onOpenDocument={async () => 'unavailable'}
              onSuggestionSelect={handleSuggestionSelect}
              onAnswerFeedback={editionController.canUseAssistantAnswerFeedback() ? handleAnswerFeedback : undefined}
              onClearAnswerFeedback={editionController.canUseAssistantAnswerFeedback() ? handleClearAnswerFeedback : undefined}
              assistantAvatarUrl={resolvedAvatarUrl}
              assistantAvatarLabel={resolvedWorkspaceName}
              hideAssistantAvatar={surface === 'embed' && isNarrowLayout}
              hideFeedbackEntries
              theme={theme}
              themedSuggestionButtons
            />
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {rateLimitError && retryAfterSeconds ? (
        <div className={`shrink-0 ${isCompactKeyboardLayout ? 'px-3 pb-2' : 'px-4 pb-2'}`}>
          <RateLimitBanner
            key={retryAfterSeconds}
            copy={copy}
            message={rateLimitError}
            retryAfterSeconds={retryAfterSeconds}
            themeOverrides={resolvedThemeOverrides}
          />
        </div>
      ) : null}

      <PublicChatBubbleComposerSurface theme={theme} compact={isCompactKeyboardLayout}>
        {!isCompactKeyboardLayout ? (
          <PublicChatBubbleDisclaimer
            theme={theme}
            copy={copy}
            workspaceName={resolvedWorkspaceName}
          />
        ) : null}
        {editionController.canUseHumanContact() && contactRequest ? (
          <HumanContactInlineComposer
            request={contactRequest}
            publicChatToken={publicChatToken}
            onCancel={() => setContactRequest(null)}
            onSubmitted={handleContactSubmitted}
            theme={theme}
            compact={isCompactKeyboardLayout}
          />
        ) : (
          <PublicChatBubbleComposerForm
            theme={theme}
            copy={copy}
            value={input}
            onChange={setInput}
            onKeyDown={handleKeyDown}
            onSubmit={handleSubmit}
            inputRef={inputRef}
            isLoading={isLoading}
            compact={isCompactKeyboardLayout}
          />
        )}
        {!isCompactKeyboardLayout ? <PublicChatBubblePoweredBy theme={theme} /> : null}
      </PublicChatBubbleComposerSurface>
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
  surface = 'public',
  pageContext,
  initialActions,
}: {
  token: string
  initialWorkspaceName?: string | null
  localeOverride?: string | null
  onStartNewChat?: () => Promise<void>
  onRequestCollapse?: () => void
  avatarUrl?: string | null
  copyOverrides?: WebsiteEmbedCopyOverrides | null
  themeOverrides?: WebsiteEmbedThemeOverrides | null
  surface?: PublicChatSurface
  pageContext?: WebsiteEmbedPageContext | null
  initialActions?: Record<string, unknown> | null
}) {
  const theme = getWebsiteEmbedTheme(themeOverrides)

  return (
    <AnonymousChatProvider
      key={token}
      token={token}
      sessionChannel={surface === 'public' ? 'anonymous_link' : null}
      initialActions={initialActions}
      localeOverride={localeOverride}
      pageContext={pageContext}
    >
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        style={{
          ...buildWebsiteEmbedSurfaceCssVars(theme),
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
          surface={surface}
        />
      </div>
    </AnonymousChatProvider>
  )
}
