import { EmbeddedChatFrame } from '@/components/chat/embedded-chat-frame'
import {
  normalizeWebsiteEmbedAvatarUrl,
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
    avatar?: string | string[]
    avatarUrl?: string | string[]
    copy?: string | string[]
    theme?: string | string[]
  }>
}) {
  const { token } = await params
  const { locale, avatar, avatarUrl, copy, theme } = await searchParams
  const localeOverride = resolveEmbedLocaleSearchParam(locale)
  const resolvedAvatarUrl = normalizeWebsiteEmbedAvatarUrl(firstSearchValue(avatarUrl) ?? firstSearchValue(avatar))
  const copyOverrides = parseWebsiteEmbedCopyOverridesParam(copy)
  const themeOverrides = parseWebsiteEmbedThemeOverridesParam(theme)

  return (
    <EmbeddedChatFrame
      token={token}
      localeOverride={localeOverride}
      avatarUrl={resolvedAvatarUrl}
      copyOverrides={copyOverrides}
      themeOverrides={themeOverrides}
    />
  )
}
