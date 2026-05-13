'use client'

import { useMemo, type CSSProperties } from 'react'
import { AlertTriangle } from 'lucide-react'

import {
  PublicChatBubbleComposerForm,
  PublicChatBubbleComposerSurface,
  PublicChatBubbleDisclaimer,
  PublicChatBubbleHeader,
} from '@/components/chat/public-chat-bubble-view'
import { ChatMessageThread, type ChatThreadMessage } from '@/components/dashboard/chat-message-thread'
import { deriveThemeOverridesFromModel } from '@/lib/anonymous-chat-context'
import type { WebsiteEmbedThemeSettings } from '@/lib/api'
import { contrastRatio } from '@/lib/color'
import {
  buildWebsiteEmbedSurfaceCssVars,
  DEFAULT_WEBSITE_EMBED_COPY,
  getWebsiteEmbedTheme,
} from '@/lib/embed-widget'

const MIN_WCAG_AA_CONTRAST = 4.5
const PREVIEW_TIMESTAMP = '2025-01-01T12:00:00.000Z'

const noopOpenDocument = async () => 'unavailable' as const
const noopSuggestionSelect = () => {}
const noopAnswerFeedback = async () => undefined

export function ThemeContrastWarning({ theme }: { theme: WebsiteEmbedThemeSettings }) {
  const brandRatio = contrastRatio(theme.brand, theme.brandText)
  const surfaceRatio = contrastRatio(theme.surface, theme.text)
  const issues: string[] = []
  if (brandRatio < MIN_WCAG_AA_CONTRAST) {
    issues.push(`Brand text on brand color (${brandRatio.toFixed(1)}:1)`)
  }
  if (surfaceRatio < MIN_WCAG_AA_CONTRAST) {
    issues.push(`Body text on chat background (${surfaceRatio.toFixed(1)}:1)`)
  }
  if (issues.length === 0) {
    return null
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">Low contrast — aim for at least 4.5:1.</p>
        <ul className="list-disc pl-4">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function ChatPreview({
  themeSettings,
  assistantName,
  logoUrl,
  showSuggestedQuestions,
  showProactiveGreeting,
}: {
  themeSettings: WebsiteEmbedThemeSettings
  assistantName: string
  logoUrl: string | null
  showSuggestedQuestions: boolean
  showProactiveGreeting: boolean
}) {
  const displayName = assistantName.trim() || 'Assistant'
  const resolvedLogo = logoUrl ?? '/radioso-logo.png'

  const themeOverrides = useMemo(
    () => deriveThemeOverridesFromModel(themeSettings),
    [themeSettings],
  )
  const embedTheme = useMemo(
    () => getWebsiteEmbedTheme(themeOverrides),
    [themeOverrides],
  )

  const messages = useMemo<ChatThreadMessage[]>(
    () => {
      const greeting: ChatThreadMessage = {
        id: 'preview-assistant-1',
        role: 'assistant',
        content: 'Hello. Ask me anything that lives in your team’s documents — I’ve read all of them, more than once.',
        createdAt: PREVIEW_TIMESTAMP,
        status: 'complete',
      }
      const userQuestion: ChatThreadMessage = {
        id: 'preview-user-1',
        role: 'user',
        content: 'What’s the meaning of life?',
        createdAt: PREVIEW_TIMESTAMP,
      }
      const assistantReply: ChatThreadMessage = {
        id: 'preview-assistant-2',
        role: 'assistant',
        content:
          'Out of scope, I’m afraid — your team hasn’t written that one down yet. I can, however, recite your refund policy from memory and explain, in three different tones, what your style guide means by “on-brand”. Pick a more answerable mystery?',
        createdAt: PREVIEW_TIMESTAMP,
        status: 'complete',
        suggestions: showSuggestedQuestions
          ? [
              { text: 'Summarize last quarter’s roadmap' },
              { text: 'What does “on-brand” actually mean here?' },
              { text: 'Read me the welcome email we send new customers' },
            ]
          : undefined,
      }
      return showProactiveGreeting
        ? [greeting, userQuestion, assistantReply]
        : [userQuestion, assistantReply]
    },
    [showProactiveGreeting, showSuggestedQuestions],
  )

  const surfaceVars = useMemo(
    () => buildWebsiteEmbedSurfaceCssVars(embedTheme) as CSSProperties,
    [embedTheme],
  )

  return (
    <div
      className="flex h-[min(40rem,calc(100vh-6rem))] min-h-[24rem] flex-col overflow-hidden rounded-2xl border shadow-sm"
      style={{
        ...surfaceVars,
        backgroundColor: embedTheme.panelBackground,
        borderColor: embedTheme.panelBorder,
        color: embedTheme.panelForeground,
      }}
      aria-label="Live chat preview"
    >
      <PublicChatBubbleHeader
        theme={embedTheme}
        themeOverrides={themeOverrides}
        workspaceName={displayName}
        avatarUrl={logoUrl}
      />

      <div className="radioso-themed-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <ChatMessageThread
          messages={messages}
          onOpenDocument={noopOpenDocument}
          onSuggestionSelect={noopSuggestionSelect}
          onAnswerFeedback={noopAnswerFeedback}
          assistantAvatarUrl={resolvedLogo}
          assistantAvatarLabel={displayName}
          theme={embedTheme}
          themedSuggestionButtons
        />
      </div>

      <PublicChatBubbleComposerSurface theme={embedTheme}>
        <PublicChatBubbleDisclaimer
          theme={embedTheme}
          copy={DEFAULT_WEBSITE_EMBED_COPY}
          workspaceName={displayName}
        />
        <PublicChatBubbleComposerForm
          theme={embedTheme}
          copy={DEFAULT_WEBSITE_EMBED_COPY}
          value=""
          readOnly
        />
      </PublicChatBubbleComposerSurface>
    </div>
  )
}
