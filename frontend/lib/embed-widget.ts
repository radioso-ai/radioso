import type { GeneralSettings } from '@/lib/api'

export type WebsiteEmbedLauncherPosition = 'bottom-right' | 'bottom-left'
export type WebsiteEmbedLauncherIcon = 'chat' | 'sparkles' | 'message'
export type WebsiteEmbedInitialState = 'open' | 'collapsed'

export interface WebsiteEmbedSnippetOverrides {
  locale?: string | null
  initialState?: string | null
  avatarUrl?: string | null
  collapsedAvatarUrl?: string | null
  copy?: WebsiteEmbedCopyOverrides | null
  theme?: WebsiteEmbedThemeOverrides | null
}

export interface WebsiteEmbedCopy {
  launcherDefaultLabel: string
  embeddedChatTitle: string
  embeddedChatUnavailableTitle: string
  embeddedChatUnavailableMessage: string
  embeddedChatLauncherRequiredMessage: string
  embeddedChatStartingMessage: string
  publicChatSubtitle: string
  publicChatEmptyTitle: string
  publicChatEmptyMessage: string
  startPrompt: string
  publicChatUnavailableTitle: string
  publicChatUnavailableMessage: string
  publicChatLoadOlderMessages: string
  publicChatSendMessageLabel: string
  publicChatNewChatLabel: string
  publicChatRateLimitRetryTemplate: string
}

export interface WebsiteEmbedTheme {
  launcherBackground: string
  launcherForeground: string
  launcherBorder: string
  launcherShadow: string
  panelBackground: string
  panelForeground: string
  panelBorder: string
  panelShadow: string
  accent: string
  accentForeground: string
  mutedBackground: string
  mutedForeground: string
  inputBackground: string
  inputForeground: string
  inputBorder: string
  inputPlaceholder: string
  assistantBubbleBackground: string
  assistantBubbleForeground: string
  userBubbleBackground: string
  userBubbleForeground: string
}

export type WebsiteEmbedCopyOverrides = Partial<WebsiteEmbedCopy>
export type WebsiteEmbedThemeOverrides = Partial<WebsiteEmbedTheme>

export const DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL = 'Chat with us'
export const DEFAULT_WEBSITE_EMBED_LAUNCHER_ICON: WebsiteEmbedLauncherIcon = 'chat'
export const DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION: WebsiteEmbedLauncherPosition = 'bottom-right'
export const DEFAULT_WEBSITE_EMBED_SCRIPT_PATH = '/radioso-embed.js'
export const DEFAULT_WEBSITE_EMBED_INITIAL_STATE: WebsiteEmbedInitialState = 'collapsed'
export const APP_WEBSITE_EMBED_DEMO_PATH = '/embed-demo.html'
export const LOCAL_WEBSITE_EMBED_TEST_HARNESS_URL = 'http://127.0.0.1:4321'
export const DEFAULT_WEBSITE_EMBED_COPY: WebsiteEmbedCopy = {
  launcherDefaultLabel: 'Chat with us',
  embeddedChatTitle: 'Radioso embedded chat',
  embeddedChatUnavailableTitle: 'Embedded Chat Unavailable',
  embeddedChatUnavailableMessage: 'This embedded chat could not be started from this website.',
  embeddedChatLauncherRequiredMessage: 'This embedded chat must be opened from the launcher script.',
  embeddedChatStartingMessage: 'Starting embedded chat...',
  publicChatSubtitle: 'Ask questions and get AI-powered answers',
  publicChatEmptyTitle: 'Start a conversation',
  publicChatEmptyMessage: 'Ask a question and get an AI-powered answer.',
  startPrompt: 'Ask a question...',
  publicChatUnavailableTitle: 'Chat Unavailable',
  publicChatUnavailableMessage: 'This chat link is no longer active. Please contact the workspace administrator for access.',
  publicChatLoadOlderMessages: 'Load older messages',
  publicChatSendMessageLabel: 'Send message',
  publicChatNewChatLabel: 'New chat',
  publicChatRateLimitRetryTemplate: 'Try again in {seconds}s.',
}
export const DEFAULT_WEBSITE_EMBED_THEME: WebsiteEmbedTheme = {
  launcherBackground: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
  launcherForeground: '#f8fafc',
  launcherBorder: 'rgba(15, 23, 42, 0.16)',
  launcherShadow: '0 18px 40px rgba(15, 23, 42, 0.24)',
  panelBackground: '#ffffff',
  panelForeground: '#0f172a',
  panelBorder: 'rgba(148, 163, 184, 0.35)',
  panelShadow: '0 24px 60px rgba(15, 23, 42, 0.28)',
  accent: '#0f172a',
  accentForeground: '#f8fafc',
  mutedBackground: '#f8fafc',
  mutedForeground: '#64748b',
  inputBackground: '#ffffff',
  inputForeground: '#0f172a',
  inputBorder: '#cbd5e1',
  inputPlaceholder: '#94a3b8',
  assistantBubbleBackground: '#ffffff',
  assistantBubbleForeground: '#0f172a',
  userBubbleBackground: '#0f172a',
  userBubbleForeground: '#f8fafc',
}

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/

const COPY_OVERRIDE_KEYS = [
  'launcherDefaultLabel',
  'embeddedChatTitle',
  'embeddedChatUnavailableTitle',
  'embeddedChatUnavailableMessage',
  'embeddedChatLauncherRequiredMessage',
  'embeddedChatStartingMessage',
  'publicChatSubtitle',
  'publicChatEmptyTitle',
  'publicChatEmptyMessage',
  'startPrompt',
  'publicChatUnavailableTitle',
  'publicChatUnavailableMessage',
  'publicChatLoadOlderMessages',
  'publicChatSendMessageLabel',
  'publicChatNewChatLabel',
  'publicChatRateLimitRetryTemplate',
] as const satisfies readonly (keyof WebsiteEmbedCopy)[]

const THEME_OVERRIDE_KEYS = [
  'launcherBackground',
  'launcherForeground',
  'launcherBorder',
  'launcherShadow',
  'panelBackground',
  'panelForeground',
  'panelBorder',
  'panelShadow',
  'accent',
  'accentForeground',
  'mutedBackground',
  'mutedForeground',
  'inputBackground',
  'inputForeground',
  'inputBorder',
  'inputPlaceholder',
  'assistantBubbleBackground',
  'assistantBubbleForeground',
  'userBubbleBackground',
  'userBubbleForeground',
] as const satisfies readonly (keyof WebsiteEmbedTheme)[]

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

const pickFirstValue = (value: string | string[] | null | undefined) =>
  Array.isArray(value) ? value[0] : value

const sanitizeOverrideValue = (value: unknown, maxLength: number) => {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) {
    return null
  }

  return trimmed
}

const sanitizeStringOverrides = <K extends string>(
  input: unknown,
  keys: readonly K[],
  maxLength: number,
) => {
  if (!input || typeof input !== 'object') {
    return {}
  }

  const next: Partial<Record<K, string>> = {}
  for (const key of keys) {
    const sanitized = sanitizeOverrideValue((input as Record<string, unknown>)[key], maxLength)
    if (sanitized) {
      next[key] = sanitized
    }
  }

  return next
}

const normalizeOrigin = (origin: string) => {
  const trimmed = origin.trim()
  if (!trimmed) {
    return null
  }

  try {
    return new URL(trimmed).origin
  } catch {
    return null
  }
}

export const parseWebsiteEmbedOrigins = (value: string) =>
  value
    .split(/\r?\n/)
    .map(normalizeOrigin)
    .filter((origin): origin is string => Boolean(origin))

export const formatWebsiteEmbedOrigins = (origins: string[]) => origins.join('\n')

export const normalizeWebsiteEmbedLocale = (value: string | null | undefined): string | null => {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 35 || !LOCALE_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}

export const normalizeWebsiteEmbedInitialState = (value: string | null | undefined): WebsiteEmbedInitialState | null => {
  if (!value) {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'open' || normalized === 'collapsed') {
    return normalized
  }

  return null
}

export const normalizeWebsiteEmbedAvatarUrl = (value: string | null | undefined): string | null => {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('//')
  ) {
    return trimmed
  }

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

export const sanitizeWebsiteEmbedCopyOverrides = (input: unknown): WebsiteEmbedCopyOverrides =>
  sanitizeStringOverrides<keyof WebsiteEmbedCopy>(input, COPY_OVERRIDE_KEYS, 280) as WebsiteEmbedCopyOverrides

export const sanitizeWebsiteEmbedThemeOverrides = (input: unknown): WebsiteEmbedThemeOverrides =>
  sanitizeStringOverrides<keyof WebsiteEmbedTheme>(input, THEME_OVERRIDE_KEYS, 160) as WebsiteEmbedThemeOverrides

export const parseWebsiteEmbedJsonOverrides = (value: string | null | undefined) => {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

export const parseWebsiteEmbedCopyOverridesParam = (value: string | string[] | null | undefined) =>
  sanitizeWebsiteEmbedCopyOverrides(parseWebsiteEmbedJsonOverrides(pickFirstValue(value)))

export const parseWebsiteEmbedThemeOverridesParam = (value: string | string[] | null | undefined) =>
  sanitizeWebsiteEmbedThemeOverrides(parseWebsiteEmbedJsonOverrides(pickFirstValue(value)))

export const formatWebsiteEmbedRateLimitRetry = (
  copy: Pick<WebsiteEmbedCopy, 'publicChatRateLimitRetryTemplate'>,
  seconds: number,
) => copy.publicChatRateLimitRetryTemplate.replaceAll('{seconds}', String(seconds))

export const getWebsiteEmbedCopy = (
  _value: string | null | undefined,
  overrides?: WebsiteEmbedCopyOverrides | null,
): WebsiteEmbedCopy => {
  return {
    ...DEFAULT_WEBSITE_EMBED_COPY,
    ...sanitizeWebsiteEmbedCopyOverrides(overrides),
  }
}

export const getWebsiteEmbedTheme = (overrides?: WebsiteEmbedThemeOverrides | null): WebsiteEmbedTheme => ({
  ...DEFAULT_WEBSITE_EMBED_THEME,
  ...sanitizeWebsiteEmbedThemeOverrides(overrides),
})

export const buildWebsiteEmbedCssVars = (theme: WebsiteEmbedTheme) =>
  ({
    '--radioso-launcher-background': theme.launcherBackground,
    '--radioso-launcher-foreground': theme.launcherForeground,
    '--radioso-launcher-border': theme.launcherBorder,
    '--radioso-launcher-shadow': theme.launcherShadow,
    '--radioso-panel-background': theme.panelBackground,
    '--radioso-panel-foreground': theme.panelForeground,
    '--radioso-panel-border': theme.panelBorder,
    '--radioso-panel-shadow': theme.panelShadow,
    '--radioso-accent': theme.accent,
    '--radioso-accent-foreground': theme.accentForeground,
    '--radioso-muted-background': theme.mutedBackground,
    '--radioso-muted-foreground': theme.mutedForeground,
    '--radioso-input-background': theme.inputBackground,
    '--radioso-input-foreground': theme.inputForeground,
    '--radioso-input-border': theme.inputBorder,
    '--radioso-input-placeholder': theme.inputPlaceholder,
    '--radioso-assistant-bubble-background': theme.assistantBubbleBackground,
    '--radioso-assistant-bubble-foreground': theme.assistantBubbleForeground,
    '--radioso-user-bubble-background': theme.userBubbleBackground,
    '--radioso-user-bubble-foreground': theme.userBubbleForeground,
  }) as Record<string, string>

export const resolveWebsiteEmbedScriptUrl = (scriptUrl?: string | null, baseUrl?: string) => {
  const normalizedScriptUrl = scriptUrl?.trim()
  if (normalizedScriptUrl) {
    return normalizedScriptUrl
  }

  if (baseUrl) {
    return new URL(DEFAULT_WEBSITE_EMBED_SCRIPT_PATH, baseUrl).toString()
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return new URL(DEFAULT_WEBSITE_EMBED_SCRIPT_PATH, window.location.origin).toString()
  }

  return DEFAULT_WEBSITE_EMBED_SCRIPT_PATH
}

export const resolveWebsiteEmbedAppOrigin = (scriptUrl?: string | null, baseUrl?: string) => {
  const resolvedScriptUrl = resolveWebsiteEmbedScriptUrl(scriptUrl, baseUrl)

  try {
    return new URL(resolvedScriptUrl, baseUrl).origin
  } catch {
    if (baseUrl) {
      try {
        return new URL(baseUrl).origin
      } catch {
        return baseUrl
      }
    }

    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin
    }

    return 'http://localhost:3000'
  }
}

export const buildWebsiteEmbedTestHarnessUrl = (
  settings: Pick<
    GeneralSettings,
    | 'websiteEmbedToken'
    | 'websiteEmbedScriptUrl'
    | 'websiteEmbedLauncherLabel'
    | 'websiteEmbedLauncherIcon'
    | 'websiteEmbedLauncherPosition'
  >,
  appBaseUrl?: string,
  overrides?: WebsiteEmbedSnippetOverrides,
  harnessBaseUrl: string = LOCAL_WEBSITE_EMBED_TEST_HARNESS_URL,
) => {
  if (!settings.websiteEmbedToken) {
    return null
  }

  const params = new URLSearchParams()
  params.set('appOrigin', resolveWebsiteEmbedAppOrigin(settings.websiteEmbedScriptUrl, appBaseUrl))
  params.set('token', settings.websiteEmbedToken)
  params.set(
    'label',
    settings.websiteEmbedLauncherLabel?.trim() || DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL,
  )
  params.set('icon', settings.websiteEmbedLauncherIcon ?? DEFAULT_WEBSITE_EMBED_LAUNCHER_ICON)
  params.set(
    'position',
    settings.websiteEmbedLauncherPosition ?? DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION,
  )

  const initialState = normalizeWebsiteEmbedInitialState(overrides?.initialState)
  const avatarUrl = normalizeWebsiteEmbedAvatarUrl(overrides?.avatarUrl ?? overrides?.collapsedAvatarUrl)
  const copyOverrides = sanitizeWebsiteEmbedCopyOverrides(overrides?.copy)
  const themeOverrides = sanitizeWebsiteEmbedThemeOverrides(overrides?.theme)

  if (initialState) {
    params.set('initialState', initialState)
  }

  if (avatarUrl) {
    params.set('avatarUrl', avatarUrl)
  }

  if (Object.keys(copyOverrides).length > 0) {
    params.set('copy', JSON.stringify(copyOverrides))
  }

  if (Object.keys(themeOverrides).length > 0) {
    params.set('theme', JSON.stringify(themeOverrides))
  }

  return `${harnessBaseUrl}/?${params.toString()}`
}

export const buildWebsiteEmbedSnippet = (
  settings: Pick<
    GeneralSettings,
    | 'websiteEmbedEnabled'
    | 'websiteEmbedToken'
    | 'websiteEmbedScriptUrl'
    | 'websiteEmbedAllowedOrigins'
    | 'websiteEmbedLauncherLabel'
    | 'websiteEmbedLauncherIcon'
    | 'websiteEmbedLauncherPosition'
  >,
  baseUrl?: string,
  overrides?: WebsiteEmbedSnippetOverrides,
) => {
  if (!settings.websiteEmbedEnabled || !settings.websiteEmbedToken) {
    return null
  }

  const scriptUrl = resolveWebsiteEmbedScriptUrl(settings.websiteEmbedScriptUrl, baseUrl)
  const launcherLabel = settings.websiteEmbedLauncherLabel?.trim() || DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL
  const launcherIcon = settings.websiteEmbedLauncherIcon ?? DEFAULT_WEBSITE_EMBED_LAUNCHER_ICON
  const launcherPosition = settings.websiteEmbedLauncherPosition ?? DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION
  const allowedOrigins = (settings.websiteEmbedAllowedOrigins ?? []).map(normalizeOrigin).filter((origin): origin is string => Boolean(origin))
  const originAttribute = allowedOrigins.length > 0 ? ` data-radioso-allowed-origins="${escapeHtmlAttribute(allowedOrigins.join(','))}"` : ''
  const initialState = normalizeWebsiteEmbedInitialState(overrides?.initialState)
  const avatarUrl = normalizeWebsiteEmbedAvatarUrl(overrides?.avatarUrl ?? overrides?.collapsedAvatarUrl)
  const copyOverrides = sanitizeWebsiteEmbedCopyOverrides(overrides?.copy)
  const themeOverrides = sanitizeWebsiteEmbedThemeOverrides(overrides?.theme)
  const initialStateAttribute = initialState ? ` data-radioso-initial-state="${escapeHtmlAttribute(initialState)}"` : ''
  const avatarAttribute = avatarUrl
    ? ` data-radioso-avatar-url="${escapeHtmlAttribute(avatarUrl)}"`
    : ''
  const copyAttribute =
    Object.keys(copyOverrides).length > 0
      ? ` data-radioso-copy="${escapeHtmlAttribute(JSON.stringify(copyOverrides))}"`
      : ''
  const themeAttribute =
    Object.keys(themeOverrides).length > 0
      ? ` data-radioso-theme="${escapeHtmlAttribute(JSON.stringify(themeOverrides))}"`
      : ''

  return [
    `<script`,
    `  async`,
    `  src="${escapeHtmlAttribute(scriptUrl)}"`,
    `  data-radioso-token="${escapeHtmlAttribute(settings.websiteEmbedToken)}"`,
    `  data-radioso-launcher-label="${escapeHtmlAttribute(launcherLabel)}"`,
    `  data-radioso-launcher-icon="${escapeHtmlAttribute(launcherIcon)}"`,
    `  data-radioso-launcher-position="${escapeHtmlAttribute(launcherPosition)}"${originAttribute}${initialStateAttribute}${avatarAttribute}${copyAttribute}${themeAttribute}`,
    `></script>`,
  ].join('\n')
}
