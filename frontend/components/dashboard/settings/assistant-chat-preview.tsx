'use client'

import { useMemo, type CSSProperties } from 'react'
import { AlertTriangle, Maximize2, MoreHorizontal, X } from 'lucide-react'

import {
  PublicChatBubbleComposerForm,
  PublicChatBubbleComposerSurface,
  PublicChatBubbleDisclaimer,
  PublicChatBubbleHeader,
} from '@/components/chat/public-chat-bubble-view'
import { ChatMessageThread, type ChatThreadMessage } from '@/components/dashboard/chat-message-thread'
import { Button } from '@/components/ui/button'
import type { AgentBrandingSettings, AnswerSegment, ChatSuggestion, Citation } from '@/lib/api'
import { deriveThemeOverridesFromModel } from '@/lib/anonymous-chat-context'
import type { WebsiteEmbedThemeSettings } from '@/lib/api'
import { contrastRatio } from '@/lib/color'
import {
  buildWebsiteEmbedSurfaceCssVars,
  DEFAULT_WEBSITE_EMBED_COPY,
  getWebsiteEmbedTheme,
} from '@/lib/embed-widget'
import { useSkillCatalog } from '@/lib/skill-catalog'

const MIN_WCAG_AA_CONTRAST = 4.5
const PREVIEW_TIMESTAMP = '2025-01-01T12:00:00.000Z'

const noopOpenDocument = async () => 'opened' as const
const noopSuggestionSelect = () => {}
const noopAnswerFeedback = async () => undefined

const previewCitations: Citation[] = [
  {
    documentId: '00000000-0000-4000-8000-000000000001',
    chunkId: '00000000-0000-4000-8000-000000000101',
    title: 'Website Embed Setup',
  },
  {
    documentId: '00000000-0000-4000-8000-000000000002',
    chunkId: '00000000-0000-4000-8000-000000000102',
    title: 'Launch Checklist',
  },
]

const previewAnswerSegments: AnswerSegment[] = [
  {
    text: 'Yes. Add the generated widget script to your docs site and approve the exact origin where it will run.',
    citationIndices: [0],
  },
  {
    text: '\n\nBefore launch, test the approved origin, confirm the widget can start a chat session, and verify that blocked origins fail closed.',
    citationIndices: [1],
  },
]

const previewSuggestions: ChatSuggestion[] = [
  { text: 'Show the full setup checklist' },
  { text: 'What origins are approved?' },
  { text: 'How do I rotate the widget token?' },
]

const buildPreviewMessages = ({
  displayName,
  showProactiveGreeting,
  showSuggestedQuestions,
}: {
  displayName: string
  showProactiveGreeting: boolean
  showSuggestedQuestions: boolean
}): ChatThreadMessage[] => {
  const greeting: ChatThreadMessage = {
    id: 'preview-assistant-1',
    role: 'assistant',
    content: `Hi, I'm ${displayName}. I can answer from your team's docs, policies, and setup guides.`,
    createdAt: PREVIEW_TIMESTAMP,
    status: 'complete',
  }
  const userQuestion: ChatThreadMessage = {
    id: 'preview-user-1',
    role: 'user',
    content: 'Can we embed this assistant on our docs site?',
    createdAt: PREVIEW_TIMESTAMP,
  }
  const assistantReply: ChatThreadMessage = {
    id: 'preview-assistant-2',
    role: 'assistant',
    content: previewAnswerSegments.map((segment) => segment.text).join(''),
    answerSegments: previewAnswerSegments,
    citations: previewCitations,
    createdAt: PREVIEW_TIMESTAMP,
    status: 'complete',
    suggestions: showSuggestedQuestions ? previewSuggestions : undefined,
  }
  return showProactiveGreeting
    ? [greeting, userQuestion, assistantReply]
    : [userQuestion, assistantReply]
}

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
  branding,
}: {
  themeSettings: WebsiteEmbedThemeSettings
  assistantName: string
  logoUrl: string | null
  showSuggestedQuestions: boolean
  showProactiveGreeting: boolean
  branding?: AgentBrandingSettings | null
}) {
  const displayName = assistantName.trim() || 'Assistant'
  const resolvedLogo = logoUrl ?? '/radioso-icon.svg'
  const skillCatalog = useSkillCatalog()

  const themeOverrides = useMemo(
    () => deriveThemeOverridesFromModel(themeSettings),
    [themeSettings],
  )
  const embedTheme = useMemo(
    () => getWebsiteEmbedTheme(themeOverrides),
    [themeOverrides],
  )

  const messages = useMemo<ChatThreadMessage[]>(
    () => buildPreviewMessages({ displayName, showProactiveGreeting, showSuggestedQuestions }),
    [displayName, showProactiveGreeting, showSuggestedQuestions],
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
        avatarUrl={resolvedLogo}
        actions={
          <>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8 pointer-events-none"
              tabIndex={-1}
              aria-hidden="true"
              style={{ color: embedTheme.accentForeground }}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8 pointer-events-none"
              tabIndex={-1}
              aria-hidden="true"
              style={{ color: embedTheme.accentForeground }}
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8 pointer-events-none"
              tabIndex={-1}
              aria-hidden="true"
              style={{ color: embedTheme.accentForeground }}
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        }
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
          skillCatalog={skillCatalog}
        />
      </div>

      <PublicChatBubbleComposerSurface theme={embedTheme}>
        <PublicChatBubbleComposerForm
          theme={embedTheme}
          copy={DEFAULT_WEBSITE_EMBED_COPY}
          value=""
          readOnly
        />
        <PublicChatBubbleDisclaimer
          theme={embedTheme}
          copy={DEFAULT_WEBSITE_EMBED_COPY}
          workspaceName={displayName}
          branding={branding}
        />
      </PublicChatBubbleComposerSurface>
    </div>
  )
}
