import { EmbeddedChatFrame } from '@/components/chat/embedded-chat-frame'
import { resolveEmbedLocaleSearchParam } from '@/lib/embed-locale'

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
