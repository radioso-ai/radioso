import { EmbeddedChatFrame } from '@/components/chat/embedded-chat-frame'

export const resolveEmbedLocaleSearchParam = (locale?: string | string[]) =>
  Array.isArray(locale) ? locale[0] : locale

export default async function EmbeddedChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ locale?: string | string[] }>
}) {
  const { token } = await params
  const { locale } = await searchParams
  const localeOverride = resolveEmbedLocaleSearchParam(locale)

  return <EmbeddedChatFrame token={token} localeOverride={localeOverride} />
}
