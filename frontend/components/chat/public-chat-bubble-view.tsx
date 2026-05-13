'use client'

import { Send, Sparkles } from 'lucide-react'
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
import {
  formatWebsiteEmbedDisclaimer,
  getWebsiteEmbedTheme,
  type WebsiteEmbedCopy,
  type WebsiteEmbedTheme,
  type WebsiteEmbedThemeOverrides,
} from '@/lib/embed-widget'

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
}: {
  theme: WebsiteEmbedTheme
  copy: WebsiteEmbedCopy
  workspaceName: string
}) {
  return (
    <div className="mx-auto mb-2 flex max-w-3xl justify-center">
      <p className="w-full text-center text-xs" style={{ color: theme.mutedForeground }}>
        {formatWebsiteEmbedDisclaimer(copy, workspaceName)}
      </p>
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
