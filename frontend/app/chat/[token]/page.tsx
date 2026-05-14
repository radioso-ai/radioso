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
      className="flex h-full w-full flex-col overflow-hidden p-0 min-[641px]:items-center min-[641px]:justify-center min-[641px]:p-4"
      style={{
        ...buildWebsiteEmbedSurfaceCssVars(resolvedTheme),
        background: resolvedTheme.mutedBackground,
        color: resolvedTheme.panelForeground,
      }}
    >
      <div
        className="flex h-full min-h-0 w-full flex-col overflow-hidden border-0 min-[641px]:h-[calc(100dvh-2rem)] min-[641px]:max-h-[calc(100dvh-2rem)] min-[641px]:w-[min(560px,calc(100vw-2rem))] min-[641px]:rounded-[28px] min-[641px]:border min-[641px]:shadow-[var(--radioso-panel-shadow)]"
        style={{
          background: resolvedTheme.panelBackground,
          borderColor: resolvedTheme.panelBorder,
        }}
      >
        <PublicChatShell
          token={token}
          localeOverride={localeOverride}
          copyOverrides={parseWebsiteEmbedCopyOverridesParam(copy)}
          themeOverrides={themeOverrides}
        />
      </div>
    </div>
  )
}
