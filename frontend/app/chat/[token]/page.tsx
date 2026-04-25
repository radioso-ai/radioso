import {
  buildWebsiteEmbedSurfaceCssVars,
  getWebsiteEmbedTheme,
  normalizeWebsiteEmbedAvatarUrl,
  parseWebsiteEmbedCopyOverridesParam,
  parseWebsiteEmbedThemeOverridesParam,
} from '@/lib/embed-widget'
import { resolveEmbedLocaleSearchParam } from '@/lib/embed-locale'
import { PublicChatShell } from '@/components/chat/public-chat-shell'

const firstSearchValue = (value?: string | string[]) => (Array.isArray(value) ? value[0] : value)

export default async function PublicChatPage({
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
  const themeOverrides = parseWebsiteEmbedThemeOverridesParam(theme)
  const resolvedTheme = getWebsiteEmbedTheme(themeOverrides)

  return (
    <div
      className="flex h-full w-full items-center justify-center"
      style={{
        ...buildWebsiteEmbedSurfaceCssVars(resolvedTheme),
        background: resolvedTheme.panelBackground,
        color: resolvedTheme.panelForeground,
      }}
    >
      <div className="flex h-full w-full max-w-4xl flex-col overflow-hidden">
        <PublicChatShell
          token={token}
          localeOverride={localeOverride}
          avatarUrl={resolvedAvatarUrl}
          copyOverrides={parseWebsiteEmbedCopyOverridesParam(copy)}
          themeOverrides={themeOverrides}
        />
      </div>
    </div>
  )
}
