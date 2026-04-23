import { EmbeddedChatFrame } from '@/components/chat/embedded-chat-frame'
import {
  normalizeWebsiteEmbedAvatarUrl,
  normalizeWebsiteEmbedDisplayMode,
  parseWebsiteEmbedCopyOverridesParam,
  parseWebsiteEmbedThemeOverridesParam,
} from '@/lib/embed-widget'
import { resolveEmbedLocaleSearchParam } from '@/lib/embed-locale'

const firstSearchValue = (value?: string | string[]) => (Array.isArray(value) ? value[0] : value)

export default async function EmbeddedChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{
    locale?: string | string[]
    displayMode?: string | string[]
    avatar?: string | string[]
    avatarUrl?: string | string[]
    copy?: string | string[]
    theme?: string | string[]
  }>
}) {
  const { token } = await params
  const { locale, displayMode, avatar, avatarUrl, copy, theme } = await searchParams
  const localeOverride = resolveEmbedLocaleSearchParam(locale)
  const resolvedDisplayMode = normalizeWebsiteEmbedDisplayMode(firstSearchValue(displayMode))
  const resolvedAvatarUrl = normalizeWebsiteEmbedAvatarUrl(firstSearchValue(avatarUrl) ?? firstSearchValue(avatar))
  const copyOverrides = parseWebsiteEmbedCopyOverridesParam(copy)
  const themeOverrides = parseWebsiteEmbedThemeOverridesParam(theme)

  return (
    <EmbeddedChatFrame
      token={token}
      localeOverride={localeOverride}
      displayMode={resolvedDisplayMode}
      avatarUrl={resolvedAvatarUrl}
      copyOverrides={copyOverrides}
      themeOverrides={themeOverrides}
    />
  )
}
