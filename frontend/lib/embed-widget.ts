import type { GeneralSettings } from '@/lib/api'

export type WebsiteEmbedLauncherPosition = 'bottom-right' | 'bottom-left'
export type WebsiteEmbedLauncherIcon = 'chat' | 'sparkles' | 'message'

export const DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL = 'Chat with us'
export const DEFAULT_WEBSITE_EMBED_LAUNCHER_ICON: WebsiteEmbedLauncherIcon = 'chat'
export const DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION: WebsiteEmbedLauncherPosition = 'bottom-right'
export const DEFAULT_WEBSITE_EMBED_SCRIPT_PATH = '/radioso-embed.js'

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
) => {
  if (!settings.websiteEmbedEnabled || !settings.websiteEmbedToken) {
    return null
  }

  const scriptUrl = resolveWebsiteEmbedScriptUrl(settings.websiteEmbedScriptUrl, baseUrl)
  const launcherLabel = settings.websiteEmbedLauncherLabel?.trim() || DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL
  const launcherIcon = settings.websiteEmbedLauncherIcon ?? DEFAULT_WEBSITE_EMBED_LAUNCHER_ICON
  const launcherPosition = settings.websiteEmbedLauncherPosition ?? DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION
  const allowedOrigins = (settings.websiteEmbedAllowedOrigins ?? []).map(normalizeOrigin).filter((origin): origin is string => Boolean(origin))
  const originAttribute = allowedOrigins.length > 0 ? ` data-radioso-allowed-origins="${allowedOrigins.join(',')}"` : ''

  return [
    `<script`,
    `  async`,
    `  src="${scriptUrl}"`,
    `  data-radioso-token="${settings.websiteEmbedToken}"`,
    `  data-radioso-launcher-label="${launcherLabel}"`,
    `  data-radioso-launcher-icon="${launcherIcon}"`,
    `  data-radioso-launcher-position="${launcherPosition}"${originAttribute}`,
    `></script>`,
  ].join('\n')
}

