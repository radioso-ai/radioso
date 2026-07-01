import { EmbeddedChatFrame } from "@/components/chat/embedded-chat-frame";
import {
  buildWebsiteEmbedSurfaceCssVars,
  getWebsiteEmbedTheme,
  normalizeWebsiteEmbedDisplayMode,
  parseWebsiteEmbedCopyOverridesParam,
  parseWebsiteEmbedThemeOverridesParam,
} from "@/lib/embed-widget";
import { headers } from "next/headers";
import { resolveEmbedLocaleOverride } from "@/lib/embed-locale";

const firstSearchValue = (value?: string | string[]) => (Array.isArray(value) ? value[0] : value);

export default async function EmbeddedChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{
    locale?: string | string[];
    displayMode?: string | string[];
    copy?: string | string[];
    theme?: string | string[];
  }>;
}) {
  const { token } = await params;
  const { locale, displayMode, copy, theme } = await searchParams;
  const localeOverride = resolveEmbedLocaleOverride({
    param: locale,
    acceptLanguage: (await headers()).get("accept-language"),
  });
  const resolvedDisplayMode = normalizeWebsiteEmbedDisplayMode(firstSearchValue(displayMode));
  const copyOverrides = parseWebsiteEmbedCopyOverridesParam(copy);
  const themeOverrides = parseWebsiteEmbedThemeOverridesParam(theme);
  const resolvedTheme = getWebsiteEmbedTheme(themeOverrides);

  return (
    <div
      className="flex h-full w-full min-h-0 flex-1 flex-col overflow-hidden"
      style={{
        ...buildWebsiteEmbedSurfaceCssVars(resolvedTheme),
        background: resolvedTheme.panelBackground,
        color: resolvedTheme.panelForeground,
      }}
    >
      <EmbeddedChatFrame
        token={token}
        localeOverride={localeOverride}
        displayMode={resolvedDisplayMode}
        copyOverrides={copyOverrides}
        themeOverrides={themeOverrides}
      />
    </div>
  );
}
