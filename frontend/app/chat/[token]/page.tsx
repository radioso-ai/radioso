import {
  buildWebsiteEmbedSurfaceCssVars,
  getWebsiteEmbedTheme,
  parseWebsiteEmbedCopyOverridesParam,
  parseWebsiteEmbedThemeOverridesParam,
} from '@/lib/embed-widget'
import { resolveEmbedLocaleSearchParam } from '@/lib/embed-locale'
import { PublicChatShell } from '@/components/chat/public-chat-shell'

export default async function PublicChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{
    locale?: string | string[]
    copy?: string | string[]
    theme?: string | string[]
  }>
}) {
  const { token } = await params
  const { locale, copy, theme } = await searchParams
  const localeOverride = resolveEmbedLocaleSearchParam(locale)
  const themeOverrides = parseWebsiteEmbedThemeOverridesParam(theme)
  const resolvedTheme = getWebsiteEmbedTheme(themeOverrides)

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      style={{
        ...buildWebsiteEmbedSurfaceCssVars(resolvedTheme),
        color: resolvedTheme.panelForeground,
      }}
    >
      <PublicChatShell
        token={token}
        localeOverride={localeOverride}
        copyOverrides={parseWebsiteEmbedCopyOverridesParam(copy)}
        themeOverrides={themeOverrides}
      />
    </div>
  )
}
