import type { GeneralSettings } from '@/lib/api'
import { normalizeLocaleTag } from '@/lib/locale'
import { resolveBuiltInEmbedCopy } from '@/lib/embed-locale-packs'

export type WebsiteEmbedLauncherPosition = 'bottom-right' | 'bottom-left'
export type WebsiteEmbedInitialState = 'open' | 'collapsed'
export type WebsiteEmbedDisplayMode = 'bubble' | 'panel'

export interface WebsiteEmbedSnippetOverrides {
  locale?: string | null
  initialState?: string | null
  displayMode?: string | null
  pageContext?: 'metadata' | 'content' | null
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
  publicChatContactHumanLabel: string
  publicChatContactHumanMessage: string
  publicChatNewChatLabel: string
  publicChatCollapseLabel: string
  publicChatOpenFullScreenLabel: string
  publicChatOpenNewTabLabel: string
  publicChatDisclaimerTemplate: string
  publicChatRateLimitRetryTemplate: string
  skillReceiptSubmittedLabel: string
  skillReceiptFailedLabel: string
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
export type WebsiteEmbedPageContextMode = 'metadata' | 'content'

export const DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL = 'Chat with us'
export const DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION: WebsiteEmbedLauncherPosition = 'bottom-right'
export const DEFAULT_WEBSITE_EMBED_SCRIPT_PATH = '/radioso-embed.js'
export const DEFAULT_WEBSITE_EMBED_TEST_PATH = '/embed-test'
export const DEFAULT_WEBSITE_EMBED_INITIAL_STATE: WebsiteEmbedInitialState = 'collapsed'
export const DEFAULT_WEBSITE_EMBED_DISPLAY_MODE: WebsiteEmbedDisplayMode = 'bubble'
export const LOCAL_WEBSITE_EMBED_TEST_HARNESS_URL = 'http://127.0.0.1:4321'
export const WEBSITE_EMBED_DESKTOP_PANEL_WIDTH_PX = 560
export const WEBSITE_EMBED_PANEL_HANDLE_WIDTH_PX = 56
export const WEBSITE_EMBED_NARROW_VIEWPORT_MAX_WIDTH_PX = 640
export const WEBSITE_EMBED_KEYBOARD_SHRINK_THRESHOLD_PX = 120
export const DEFAULT_WEBSITE_EMBED_COPY: WebsiteEmbedCopy = {
  launcherDefaultLabel: 'Chat with us',
  embeddedChatTitle: 'Radioso embedded chat',
  embeddedChatUnavailableTitle: 'Embedded Chat Unavailable',
  embeddedChatUnavailableMessage: 'This embedded chat could not be started from this website.',
  embeddedChatLauncherRequiredMessage: 'This embedded chat must be opened from the launcher script.',
  embeddedChatStartingMessage: 'Summoning {name}...',
  publicChatSubtitle: '',
  publicChatEmptyTitle: 'Start a conversation',
  publicChatEmptyMessage: 'Ask a question and get an AI-powered answer.',
  startPrompt: 'Ask a question...',
  publicChatUnavailableTitle: 'Chat Unavailable',
  publicChatUnavailableMessage: 'This chat link is no longer active. Please contact the workspace administrator for access.',
  publicChatLoadOlderMessages: 'Load older messages',
  publicChatSendMessageLabel: 'Send message',
  publicChatContactHumanLabel: 'Talk to a human',
  publicChatContactHumanMessage: 'I want to talk to a human.',
  publicChatNewChatLabel: 'Clear chat',
  publicChatCollapseLabel: 'Collapse chat',
  publicChatOpenFullScreenLabel: 'Open full screen',
  publicChatOpenNewTabLabel: 'Open in new tab',
  publicChatDisclaimerTemplate: '{name} uses AI and can make mistakes.',
  publicChatRateLimitRetryTemplate: 'Try again in {seconds}s.',
  skillReceiptSubmittedLabel: 'Submitted',
  skillReceiptFailedLabel: "Couldn't submit",
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

export const COPY_OVERRIDE_KEYS = [
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
  'publicChatContactHumanLabel',
  'publicChatContactHumanMessage',
  'publicChatNewChatLabel',
  'publicChatCollapseLabel',
  'publicChatOpenFullScreenLabel',
  'publicChatOpenNewTabLabel',
  'publicChatDisclaimerTemplate',
  'publicChatRateLimitRetryTemplate',
  'skillReceiptSubmittedLabel',
  'skillReceiptFailedLabel',
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

export const normalizeWebsiteEmbedLocale = normalizeLocaleTag

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

export const normalizeWebsiteEmbedDisplayMode = (value: string | null | undefined): WebsiteEmbedDisplayMode | null => {
  if (!value) {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'bubble' || normalized === 'panel') {
    return normalized
  }

  return null
}

export const normalizeWebsiteEmbedPageContextMode = (value: string | null | undefined): WebsiteEmbedPageContextMode | null => {
  if (!value) {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'metadata' || normalized === 'content') {
    return normalized
  }

  return null
}

export const sanitizeWebsiteEmbedCopyOverrides = (input: unknown): WebsiteEmbedCopyOverrides =>
  sanitizeStringOverrides<keyof WebsiteEmbedCopy>(input, COPY_OVERRIDE_KEYS, 280) as WebsiteEmbedCopyOverrides

/**
 * Select the persisted wording pack for a public surface. This mirrors the
 * launcher's exact-then-base matching so a shared link and embedded widget use
 * the same operator wording for a visitor locale.
 */
export const resolveWebsiteEmbedCopyPack = (
  copyPacks: Record<string, unknown> | null | undefined,
  locale: string | null | undefined,
): WebsiteEmbedCopyOverrides => {
  if (!copyPacks || typeof copyPacks !== 'object') {
    return {}
  }

  const findPack = (candidate: string) => {
    const normalizedCandidate = candidate.trim().toLowerCase()
    return Object.entries(copyPacks).find(([key, value]) =>
      key.trim().toLowerCase() === normalizedCandidate && value && typeof value === 'object' && !Array.isArray(value),
    )?.[1]
  }

  const normalizedLocale = locale?.trim().toLowerCase()
  const candidates = normalizedLocale
    ? [normalizedLocale, normalizedLocale.split('-')[0], 'default', 'en']
    : ['default', 'en']

  for (const candidate of candidates) {
    if (!candidate) continue
    const pack = findPack(candidate)
    if (pack) {
      return sanitizeWebsiteEmbedCopyOverrides(pack)
    }
  }

  return {}
}

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

export const formatWebsiteEmbedStartingMessage = (
  copy: Pick<WebsiteEmbedCopy, 'embeddedChatStartingMessage' | 'embeddedChatTitle'>,
) => copy.embeddedChatStartingMessage.replaceAll('{name}', copy.embeddedChatTitle)

export const formatWebsiteEmbedDisclaimer = (
  copy: Pick<WebsiteEmbedCopy, 'publicChatDisclaimerTemplate'>,
  name: string,
) => copy.publicChatDisclaimerTemplate.replaceAll('{name}', name)

export interface WebsiteEmbedViewportSnapshot {
  viewportWidth: number
  layoutViewportHeight: number
  visualViewportHeight?: number | null
  maxLayoutViewportHeight?: number | null
  editableFocused: boolean
}

export const shouldUseWebsiteEmbedNarrowLayout = (viewportWidth: number) =>
  viewportWidth <= WEBSITE_EMBED_NARROW_VIEWPORT_MAX_WIDTH_PX

export const shouldUseWebsiteEmbedCompactKeyboardLayout = ({
  viewportWidth,
  layoutViewportHeight,
  visualViewportHeight,
  maxLayoutViewportHeight,
  editableFocused,
}: WebsiteEmbedViewportSnapshot) => {
  if (!editableFocused || !shouldUseWebsiteEmbedNarrowLayout(viewportWidth)) {
    return false
  }

  if (typeof visualViewportHeight === 'number') {
    if (layoutViewportHeight - visualViewportHeight >= WEBSITE_EMBED_KEYBOARD_SHRINK_THRESHOLD_PX) {
      return true
    }
  }

  if (typeof maxLayoutViewportHeight === 'number') {
    return maxLayoutViewportHeight - layoutViewportHeight >= WEBSITE_EMBED_KEYBOARD_SHRINK_THRESHOLD_PX
  }

  return visualViewportHeight === null
}

// Resolve the in-frame copy for a visitor locale. Layers, lowest priority
// first: the English baseline, the best-matching built-in translation pack for
// `locale`, then operator/script overrides. `locale` is a single visitor
// language tag (exact-then-base matched, e.g. `fr-CA` -> `fr`); the public-link
// pages resolve it from `?locale` or `Accept-Language`. The embedded widget
// already carries fully-resolved `overrides` from the launcher, so this stays a
// no-op layer there unless a locale is also supplied.
export const getWebsiteEmbedCopy = (
  locale: string | null | undefined,
  overrides?: WebsiteEmbedCopyOverrides | null,
): WebsiteEmbedCopy => {
  return {
    ...DEFAULT_WEBSITE_EMBED_COPY,
    ...resolveBuiltInEmbedCopy([locale]),
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

export const buildWebsiteEmbedSurfaceCssVars = (theme: WebsiteEmbedTheme) =>
  ({
    ...buildWebsiteEmbedCssVars(theme),
    '--background': theme.panelBackground,
    '--foreground': theme.panelForeground,
    '--card': theme.panelBackground,
    '--card-foreground': theme.panelForeground,
    '--popover': theme.panelBackground,
    '--popover-foreground': theme.panelForeground,
    '--primary': theme.accent,
    '--primary-foreground': theme.accentForeground,
    '--secondary': theme.mutedBackground,
    '--secondary-foreground': theme.panelForeground,
    '--muted': theme.mutedBackground,
    '--muted-foreground': theme.mutedForeground,
    '--accent': theme.mutedBackground,
    '--accent-foreground': theme.panelForeground,
    '--border': theme.panelBorder,
    '--input': theme.inputBorder,
    '--ring': theme.accent,
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

const appendSearchParams = (baseUrl: string, params: URLSearchParams) => {
  try {
    const url = new URL(baseUrl)
    url.search = params.toString()
    return url.toString()
  } catch {
    return `${baseUrl.replace(/[?#].*$/, '')}?${params.toString()}`
  }
}

export const resolveWebsiteEmbedTestHarnessUrl = (appBaseUrl?: string, harnessBaseUrl?: string) => {
  const normalizedHarnessBaseUrl = harnessBaseUrl?.trim()
  if (normalizedHarnessBaseUrl) {
    return normalizedHarnessBaseUrl
  }

  if (appBaseUrl) {
    return new URL(DEFAULT_WEBSITE_EMBED_TEST_PATH, appBaseUrl).toString()
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return new URL(DEFAULT_WEBSITE_EMBED_TEST_PATH, window.location.origin).toString()
  }

  return LOCAL_WEBSITE_EMBED_TEST_HARNESS_URL
}

export const buildWebsiteEmbedTestHarnessUrl = (
  settings: Pick<
    GeneralSettings,
    | 'websiteEmbedToken'
    | 'websiteEmbedScriptUrl'
    | 'websiteEmbedLauncherLabel'
    | 'websiteEmbedLauncherPosition'
  >,
  appBaseUrl?: string,
  overrides?: WebsiteEmbedSnippetOverrides,
  harnessBaseUrl?: string,
) => {
  if (!settings.websiteEmbedToken) {
    return null
  }

  const params = new URLSearchParams()
  params.set('appOrigin', resolveWebsiteEmbedAppOrigin(settings.websiteEmbedScriptUrl, appBaseUrl))
  params.set('token', settings.websiteEmbedToken)

  const displayMode = normalizeWebsiteEmbedDisplayMode(overrides?.displayMode)
  const initialState = normalizeWebsiteEmbedInitialState(overrides?.initialState)
  const copyOverrides = sanitizeWebsiteEmbedCopyOverrides(overrides?.copy)
  const themeOverrides = sanitizeWebsiteEmbedThemeOverrides(overrides?.theme)
  const pageContextMode = normalizeWebsiteEmbedPageContextMode(overrides?.pageContext)

  if (displayMode && displayMode !== DEFAULT_WEBSITE_EMBED_DISPLAY_MODE) {
    params.set('displayMode', displayMode)
  }

  if (initialState) {
    params.set('initialState', initialState)
  }

  if (Object.keys(copyOverrides).length > 0) {
    params.set('copy', JSON.stringify(copyOverrides))
  }

  if (Object.keys(themeOverrides).length > 0) {
    params.set('theme', JSON.stringify(themeOverrides))
  }

  if (pageContextMode && pageContextMode !== 'metadata') {
    params.set('pageContext', pageContextMode)
  }

  return appendSearchParams(resolveWebsiteEmbedTestHarnessUrl(appBaseUrl, harnessBaseUrl), params)
}

export const buildWebsiteEmbedSnippet = (
  settings: Pick<
    GeneralSettings,
    | 'websiteEmbedEnabled'
    | 'websiteEmbedToken'
    | 'websiteEmbedScriptUrl'
  >,
  baseUrl?: string,
) => {
  if (!settings.websiteEmbedEnabled || !settings.websiteEmbedToken) {
    return null
  }

  const scriptUrl = settings.websiteEmbedScriptUrl?.trim()
    || (baseUrl ? resolveWebsiteEmbedScriptUrl(settings.websiteEmbedScriptUrl, baseUrl) : null)
  if (!scriptUrl) {
    return null
  }
  return [
    `<script`,
    `  async`,
    `  src="${escapeHtmlAttribute(scriptUrl)}"`,
    `  data-radioso-token="${escapeHtmlAttribute(settings.websiteEmbedToken)}"`,
    `></script>`,
  ].join('\n')
}
