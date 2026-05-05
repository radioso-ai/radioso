declare module '@/components/chat/public-chat-shell' {
  import type { ComponentType } from 'react'

  export const PublicChatShell: ComponentType<{
    token: string
    initialWorkspaceName?: string | null
    localeOverride?: string | null
    onStartNewChat?: () => Promise<void>
    onRequestCollapse?: () => void
    avatarUrl?: string | null
    copyOverrides?: import('@/lib/embed-widget').WebsiteEmbedCopyOverrides | null
    themeOverrides?: import('@/lib/embed-widget').WebsiteEmbedThemeOverrides | null
    surface?: 'public' | 'embed'
    pageContext?: import('@/lib/api').WebsiteEmbedPageContext | null
    initialActions?: Record<string, unknown> | null
  }>
}

declare module '@/components/ui/spinner' {
  import type { ComponentType } from 'react'

  export const LogoSpinner: ComponentType<{ className?: string; imageClassName?: string }>
}

declare module '@/lib/api' {
  export interface WebsiteEmbedPageContext {
    pageUrl?: string | null
    pageTitle?: string | null
    pageLocale?: string | null
    browserLocale?: string | null
    content?: string | null
  }

  export interface StoredEmbedBootstrapSession {
    publicChatToken: string
    publicSessionId: string
    publicSessionToken: string
    workspaceName?: string | null
    actions?: Record<string, unknown>
    expiresAt: string
  }

  export function clearStoredAnonymousSession(token: string): void
  export function clearStoredEmbedBootstrapSession(token: string): void
  export function readStoredAnonymousSessionId(token: string): string | null
  export function readStoredEmbedBootstrapSession(token: string): StoredEmbedBootstrapSession | null
  export function storeEmbedBootstrapSession(token: string, session: StoredEmbedBootstrapSession | null): void
}

declare module '@/lib/embed-locale' {
  export function resolveEmbedLocaleSearchParam(value?: string | string[]): string | null
}

declare module '@/lib/embed-widget' {
  export type WebsiteEmbedCopyOverrides = Partial<WebsiteEmbedCopy>
  export type WebsiteEmbedThemeOverrides = Partial<WebsiteEmbedTheme>
  export type WebsiteEmbedDisplayMode = 'bubble' | 'panel'

  export interface WebsiteEmbedCopy {
    embeddedChatTitle: string
    embeddedChatUnavailableTitle: string
    embeddedChatLauncherRequiredMessage: string
    embeddedChatStartingMessage: string
  }

  export interface WebsiteEmbedTheme {
    panelBackground: string
    panelForeground: string
    mutedBackground: string
    mutedForeground: string
  }

  export function buildWebsiteEmbedSurfaceCssVars(theme: WebsiteEmbedTheme): Record<string, string>
  export function formatWebsiteEmbedStartingMessage(copy: Pick<WebsiteEmbedCopy, 'embeddedChatStartingMessage' | 'embeddedChatTitle'>): string
  export function getWebsiteEmbedCopy(locale?: string | null, overrides?: WebsiteEmbedCopyOverrides | null): WebsiteEmbedCopy
  export function getWebsiteEmbedTheme(overrides?: WebsiteEmbedThemeOverrides | null): WebsiteEmbedTheme
  export function normalizeWebsiteEmbedAvatarUrl(value?: string | null): string | null
  export function normalizeWebsiteEmbedDisplayMode(value?: string | null): WebsiteEmbedDisplayMode
  export function parseWebsiteEmbedCopyOverridesParam(value?: string | string[]): WebsiteEmbedCopyOverrides | null
  export function parseWebsiteEmbedThemeOverridesParam(value?: string | string[]): WebsiteEmbedThemeOverrides | null
}
