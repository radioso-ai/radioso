'use client'

import { Send, Sparkles, X } from 'lucide-react'
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  Ref,
} from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { TypingIndicator } from '@/components/ui/typing-indicator'
import {
  formatWebsiteEmbedDisclaimer,
  getWebsiteEmbedTheme,
  type WebsiteEmbedCopy,
  type WebsiteEmbedTheme,
  type WebsiteEmbedThemeOverrides,
} from '@/lib/embed-widget'
import type { AgentBrandingSettings } from '@/lib/api'

const POWERED_BY_URL = 'https://radioso.ai'
const POWERED_BY_LABEL = 'Radioso'

const DEFAULT_ASSISTANT_AVATAR_URL = '/radioso-icon.svg'

export function AssistantAvatar({
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
  const resolvedAvatarUrl = avatarUrl ?? DEFAULT_ASSISTANT_AVATAR_URL

  return (
    <Avatar
      className={`${className} rounded-xl border`}
      style={{
        borderColor: theme.panelBorder,
        background: theme.mutedBackground,
        color: theme.accent,
      }}
    >
      <AvatarImage src={resolvedAvatarUrl} alt={label} className="object-cover" />
      <AvatarFallback
        className="rounded-xl"
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

export function PublicChatBubbleHeader({
  theme,
  themeOverrides,
  workspaceName,
  subtitle,
  avatarUrl,
  actions,
  showStatus = true,
}: {
  theme: WebsiteEmbedTheme
  themeOverrides?: WebsiteEmbedThemeOverrides | null
  workspaceName: string
  subtitle?: string
  avatarUrl?: string | null
  actions?: ReactNode
  showStatus?: boolean
}) {
  const customSubtitle = subtitle && subtitle.trim() ? subtitle.trim() : null
  return (
    <div
      className="shrink-0 border-b px-6 py-4"
      style={{
        borderColor: theme.panelBorder,
        background: theme.accent,
        color: theme.accentForeground,
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="relative">
            <AssistantAvatar
              avatarUrl={avatarUrl}
              label={workspaceName}
              themeOverrides={themeOverrides}
              className="size-10"
            />
            {showStatus ? (
              <span
                className="absolute -bottom-0.5 -right-0.5 block size-2.5 rounded-full"
                style={{
                  background: '#10b981',
                  boxShadow: `0 0 0 2px ${theme.accent}`,
                }}
                aria-label="Online"
              />
            ) : null}
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">{workspaceName}</h1>
            {customSubtitle ? (
              <p className="text-xs opacity-80">{customSubtitle}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="mt-1 flex items-center gap-1">{actions}</div> : null}
      </div>
    </div>
  )
}

export function PublicChatBubbleDisclaimer({
  theme,
  copy,
  workspaceName,
  branding,
}: {
  theme: WebsiteEmbedTheme
  copy: WebsiteEmbedCopy
  workspaceName: string
  branding?: AgentBrandingSettings | null
}) {
  const disclaimer = formatWebsiteEmbedDisclaimer(copy, workspaceName).trim()
  const showPoweredBy = !branding?.hidePoweredBy
  const privacyPolicyUrl = branding?.privacyPolicyUrl?.trim() || null
  const linkStyle = { color: theme.mutedForeground }

  const rightItems: ReactNode[] = []
  if (privacyPolicyUrl) {
    rightItems.push(
      <a
        key="privacy"
        href={privacyPolicyUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="underline-offset-2 hover:underline"
        style={linkStyle}
      >
        Privacy
      </a>,
    )
  }
  if (showPoweredBy) {
    rightItems.push(
      <a
        key="powered-by"
        href={POWERED_BY_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
        style={linkStyle}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/radioso-icon.svg" alt="" aria-hidden="true" className="h-3 w-3 opacity-80" />
        <span>
          Answers by <span className="font-medium">{POWERED_BY_LABEL}</span>
        </span>
      </a>,
    )
  }

  if (!disclaimer && rightItems.length === 0) {
    return null
  }

  return (
    <div className="@container mx-auto mt-1.5 w-full max-w-3xl px-2">
      <div
        className="flex flex-col items-center gap-y-1 text-[11px] leading-tight @sm:flex-row @sm:justify-between @sm:gap-x-3"
        style={{ color: theme.mutedForeground }}
      >
        <p className="min-w-0 text-center @sm:flex-1 @sm:text-left">{disclaimer}</p>
        {rightItems.length > 0 ? (
          <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 @sm:shrink-0 @sm:justify-end">
            {rightItems.map((item, index) => (
              <span key={index} className="inline-flex items-center gap-x-2">
                {index > 0 ? <span aria-hidden="true" className="opacity-60">·</span> : null}
                {item}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export interface PublicChatBubbleComposerFormProps {
  theme: WebsiteEmbedTheme
  copy: WebsiteEmbedCopy
  value: string
  onChange?: (next: string) => void
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void
  inputRef?: Ref<HTMLTextAreaElement>
  isLoading?: boolean
  compact?: boolean
  hero?: boolean
  readOnly?: boolean
}

export function PublicChatBubbleComposerForm({
  theme,
  copy,
  value,
  onChange,
  onSubmit,
  onKeyDown,
  inputRef,
  isLoading = false,
  compact = false,
  hero = false,
  readOnly = false,
}: PublicChatBubbleComposerFormProps) {
  const sendDisabled = readOnly || isLoading || !value.trim()
  const containerPadding = hero ? 'px-3 py-3' : 'px-2 py-1.5'
  const textareaSize = hero
    ? 'min-h-[44px] max-h-48 px-3 py-2.5 text-base'
    : compact
      ? 'min-h-9 max-h-24 px-2 py-1.5'
      : 'min-h-[36px] max-h-32 px-2 py-1.5'
  const buttonSize = hero ? 'h-11 w-11' : 'h-9 w-9'
  const buttonIconSize = hero ? 'h-5 w-5' : 'h-4 w-4'

  return (
    <form
      onSubmit={(event) => {
        if (readOnly) {
          event.preventDefault()
          return
        }
        onSubmit?.(event)
      }}
      className="mx-auto max-w-3xl"
    >
      <div
        className={`flex items-end gap-1 rounded-3xl border ${containerPadding} transition-colors focus-within:ring-2 focus-within:ring-offset-0 ${hero ? 'shadow-sm' : ''} ${readOnly ? 'pointer-events-none' : ''}`}
        style={{
          background: theme.inputBackground,
          borderColor: theme.inputBorder,
          ['--tw-ring-color' as string]: theme.accent,
        } as CSSProperties}
      >
        <Textarea
          ref={inputRef}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={onKeyDown}
          readOnly={readOnly}
          tabIndex={readOnly ? -1 : undefined}
          placeholder={copy.startPrompt}
          className={`${textareaSize} flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 placeholder:text-[var(--radioso-input-placeholder)] dark:bg-transparent`}
          style={{ color: theme.inputForeground }}
          aria-hidden={readOnly ? 'true' : undefined}
        />
        <Button
          type="submit"
          size="icon"
          className={`${buttonSize} shrink-0 rounded-full hover:opacity-90`}
          disabled={sendDisabled}
          // Keep focus on the textarea so tapping send on mobile submits on the
          // first tap instead of just dismissing the keyboard. Moving focus to
          // the button blurs the input, which hides the keyboard and reflows the
          // layout out from under the finger before the click lands. Guarding on
          // mousedown blocks the focus shift while leaving the click/submit
          // intact (preventing pointerdown can cancel the synthesized click).
          onMouseDown={(event) => event.preventDefault()}
          tabIndex={readOnly ? -1 : undefined}
          style={{
            background: theme.accent,
            color: theme.accentForeground,
          }}
          aria-hidden={readOnly ? 'true' : undefined}
        >
          <Send className={buttonIconSize} />
          <span className="sr-only">{copy.publicChatSendMessageLabel}</span>
        </Button>
      </div>
    </form>
  )
}

export function PublicChatBubbleComposerSurface({
  theme,
  compact = false,
  children,
}: {
  theme: WebsiteEmbedTheme
  compact?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={`shrink-0 border-t ${compact ? 'px-3 py-2' : 'px-6 pb-3 pt-2'}`}
      style={{
        borderColor: theme.panelBorder,
        background: theme.panelBackground,
      }}
    >
      {children}
    </div>
  )
}

// The loading view shown while the session/history are still being fetched.
// It mirrors the centered greeting intro — avatar, name, a typing bubble, and a
// (read-only) composer — so opening the widget lands directly on the chat window
// with the assistant "typing", instead of a separate full-screen loading splash.
// The composer goes live and the typing bubble fills with the greeting once the
// live chat takes over, so the transition is seamless.
export function PublicChatConnectingView({
  theme,
  themeOverrides,
  copy,
  workspaceName,
  avatarUrl,
  branding = null,
  onRequestCollapse,
}: {
  theme: WebsiteEmbedTheme
  themeOverrides?: WebsiteEmbedThemeOverrides | null
  copy: WebsiteEmbedCopy
  workspaceName: string
  avatarUrl?: string | null
  branding?: AgentBrandingSettings | null
  onRequestCollapse?: () => void
}) {
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      style={{ background: theme.panelBackground, color: theme.panelForeground }}
    >
      {onRequestCollapse ? (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
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
          <div className="flex justify-center">
            <TypingIndicator />
          </div>
          <div className="w-full pt-2">
            <PublicChatBubbleComposerForm theme={theme} copy={copy} value="" readOnly hero />
          </div>
          <PublicChatBubbleDisclaimer
            theme={theme}
            copy={copy}
            workspaceName={workspaceName}
            branding={branding}
          />
        </div>
      </div>
    </div>
  )
}
