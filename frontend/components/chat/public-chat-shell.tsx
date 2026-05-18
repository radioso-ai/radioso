'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

import { MoreHorizontal, RotateCcw, UserRound, X } from 'lucide-react'

import {
  AssistantAvatar,
  PublicChatBubbleComposerForm,
  PublicChatBubbleComposerSurface,
  PublicChatBubbleDisclaimer,
  PublicChatBubbleHeader,
} from '@/components/chat/public-chat-bubble-view'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { TypingIndicator } from '@/components/ui/typing-indicator'
import { ChatMessageThread, type ChatThreadMessage } from '@/components/dashboard/chat-message-thread'
import { AssistantMessageContent } from '@/components/dashboard/chat-citations'
import { ScrollToBottomButton } from '@/components/chat/scroll-to-bottom-button'
import { useChatScroll } from '@/hooks/use-chat-scroll'
import { AnonymousChatProvider, useAnonymousChat } from '@/lib/anonymous-chat-context'
import {
  answerFeedbackApi,
  type AgentBrandingSettings,
  type AnswerFeedbackState,
  type AnswerFeedbackValue,
  type ChatSuggestion,
  type WebsiteEmbedPageContext,
} from '@/lib/api'
import { editionController } from '@/lib/edition-controller'
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
const HUMAN_CONTACT_SKILL_NAME = 'human_contact.request'
const HUMAN_CONTACT_INTENT_NAME = 'explicit_contact_request'

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

function useWebsiteEmbedViewportLayout() {
  const [layout, setLayout] = useState({ isCompactKeyboardLayout: false, isNarrowLayout: false })
  const maxLayoutViewportHeightRef = useRef(0)

  useEffect(() => {
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
  }, [])

  return layout
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

function PublicChatOptionsMenu({
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
            {copy.publicChatContactHumanLabel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PublicChatCenteredIntro({
  copy,
  theme,
  themeOverrides,
  workspaceName,
  avatarUrl,
  greetingMessage,
  onSuggestionSelect,
  isLoading,
  branding,
  children,
}: {
  copy: ReturnType<typeof getWebsiteEmbedCopy>
  theme: ReturnType<typeof getWebsiteEmbedTheme>
  themeOverrides?: WebsiteEmbedThemeOverrides | null
  workspaceName: string
  avatarUrl?: string | null
  greetingMessage: ChatThreadMessage | null
  onSuggestionSelect: (suggestion: ChatSuggestion, messageId: string) => void
  isLoading: boolean
  branding?: AgentBrandingSettings | null
  children: ReactNode
}) {
  const visibleSuggestions = greetingMessage?.suggestions ?? []
  const showGreetingTyping = greetingMessage?.status === 'streaming' && !greetingMessage.content
  const hasGreetingContent = greetingMessage && (showGreetingTyping || greetingMessage.content)

  return (
    <div
      className="radioso-themed-scrollbar relative flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-8"
      style={{ background: theme.panelBackground }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-6 pb-[12vh]">
        <div className="flex flex-col items-center gap-3">
          <AssistantAvatar
            avatarUrl={avatarUrl}
            label={workspaceName}
            themeOverrides={themeOverrides}
            className="size-20"
          />
          <h2 className="text-2xl font-semibold" style={{ color: theme.panelForeground }}>
            {workspaceName}
          </h2>
        </div>
        {hasGreetingContent ? (
          <div className="max-w-xl text-center text-base leading-relaxed" style={{ color: theme.panelForeground }}>
            {showGreetingTyping ? (
              <div className="flex justify-center">
                <TypingIndicator />
              </div>
            ) : (
              <AssistantMessageContent
                content={greetingMessage!.content}
                citations={greetingMessage!.citations}
                answerSegments={greetingMessage!.answerSegments}
                onOpenDocument={async () => 'unavailable'}
                theme={theme}
                isStreaming={greetingMessage!.status === 'streaming'}
                showCitations={false}
              />
            )}
          </div>
        ) : (
          <p className="max-w-xl text-center text-sm" style={{ color: theme.mutedForeground }}>
            {copy.publicChatEmptyMessage}
          </p>
        )}
        {greetingMessage && visibleSuggestions.length > 0 ? (
          <div className="flex w-full flex-wrap justify-center gap-1.5">
            {visibleSuggestions
              .filter((suggestion) => suggestion.text.trim())
              .map((suggestion, suggestionIndex) => {
                return (
                  <Button
                    key={`centered-suggestion-${suggestionIndex}`}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isLoading}
                    className="h-auto max-w-full whitespace-normal rounded-full px-3 py-1 text-left text-sm leading-snug shadow-none transition-colors"
                    style={{
                      background: theme.mutedBackground,
                      borderColor: theme.panelBorder,
                      color: theme.panelForeground,
                    }}
                    onClick={() => onSuggestionSelect(suggestion, greetingMessage.id)}
                  >
                    {suggestion.text}
                  </Button>
                )
              })}
          </div>
        ) : null}
        <div className="w-full pt-2">{children}</div>
        <PublicChatBubbleDisclaimer theme={theme} copy={copy} workspaceName={workspaceName} branding={branding} />
      </div>
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
  const viewportLayout = useWebsiteEmbedViewportLayout()
  const isCompactKeyboardLayout = surface === 'embed' && viewportLayout.isCompactKeyboardLayout
  const isNarrowLayout = viewportLayout.isNarrowLayout
  const {
    publicChatToken,
    messages,
    workspaceName,
    assistantAvatarUrl,
    assistantTheme,
    branding,
    intakeActions,
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
  const contactAvailable =
    editionController.canUseHumanContact() &&
    intakeActions.some((action) => action.skillName === HUMAN_CONTACT_SKILL_NAME)
  const contactDisabled = isLoading || isHydrating || isLoadingOlderMessages
  const clearDisabled = isLoading || isHydrating || isLoadingOlderMessages
  const visibleMessages = messages
  const hasUserMessage = visibleMessages.some((message) => message.role === 'user')
  const useCenteredIntro = !hasUserMessage && !isCompactKeyboardLayout && !isNarrowLayout
  const greetingMessage = visibleMessages.find((message) => message.role === 'assistant') ?? null

  const { isAtBottom, scrollToBottom, scrollToLatestTurn } = useChatScroll({
    messages: visibleMessages,
    containerRef: messagesScrollRef,
    sentinelRef: messagesEndRef,
    pinUserMessage: !isCompactKeyboardLayout,
  })

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
  }, [isCompactKeyboardLayout, messages.length, scrollToBottom])

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
    setInput('')
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

  const handleSuggestionSelect = (suggestion: ChatSuggestion, messageId: string) => {
    if (isLoading) return

    void sendMessage(suggestion.text, {
      method: 'suggestion_click',
      suggestionSourceMessageId: messageId,
    })
  }

  const handleManualContact = () => {
    if (!contactAvailable || contactDisabled) return

    void sendMessage(copy.publicChatContactHumanMessage, {
      method: 'intent_click',
      intent: {
        skillName: HUMAN_CONTACT_SKILL_NAME,
        intentName: HUMAN_CONTACT_INTENT_NAME,
      },
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
      {(isCompactKeyboardLayout && onRequestCollapse) || useCenteredIntro ? (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
          <PublicChatOptionsMenu
            copy={copy}
            theme={theme}
            contactAvailable={contactAvailable}
            contactDisabled={contactDisabled}
            clearDisabled={clearDisabled}
            onContact={handleManualContact}
            onClear={() => void handleStartNewChat()}
          />
          {onRequestCollapse ? (
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
          ) : null}
        </div>
      ) : null}

      {!isCompactKeyboardLayout && !useCenteredIntro ? (
        <PublicChatBubbleHeader
          theme={theme}
          themeOverrides={resolvedThemeOverrides}
          workspaceName={resolvedWorkspaceName}
          subtitle={copy.publicChatSubtitle}
          avatarUrl={resolvedAvatarUrl}
          actions={
            <>
              <PublicChatOptionsMenu
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

      {useCenteredIntro ? (
        <PublicChatCenteredIntro
          copy={copy}
          theme={theme}
          themeOverrides={resolvedThemeOverrides}
          workspaceName={resolvedWorkspaceName}
          avatarUrl={resolvedAvatarUrl}
          greetingMessage={greetingMessage}
          onSuggestionSelect={handleSuggestionSelect}
          isLoading={isLoading}
          branding={branding}
        >
          <PublicChatBubbleComposerForm
            theme={theme}
            copy={copy}
            value={input}
            onChange={setInput}
            onKeyDown={handleKeyDown}
            onSubmit={handleSubmit}
            inputRef={inputRef}
            isLoading={isLoading}
            compact={false}
            hero
          />
        </PublicChatCenteredIntro>
      ) : (
        <>
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
                  showCitations={false}
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

          <div className="relative">
            {!isAtBottom && visibleMessages.length > 0 ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 mb-2 px-4">
                <div className="mx-auto flex max-w-3xl justify-end">
                  <ScrollToBottomButton
                    theme={theme}
                    onClick={() => scrollToLatestTurn()}
                  />
                </div>
              </div>
            ) : null}
            <PublicChatBubbleComposerSurface theme={theme} compact={isCompactKeyboardLayout}>
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
              {!isCompactKeyboardLayout ? (
                <PublicChatBubbleDisclaimer
                  theme={theme}
                  copy={copy}
                  workspaceName={resolvedWorkspaceName}
                  branding={branding}
                />
              ) : null}
            </PublicChatBubbleComposerSurface>
          </div>
        </>
      )}
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
}) {
  const theme = getWebsiteEmbedTheme(themeOverrides)

  return (
    <AnonymousChatProvider
      key={token}
      token={token}
      sessionChannel={surface === 'public' ? 'anonymous_link' : null}
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
