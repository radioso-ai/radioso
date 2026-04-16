import { EmbeddedChatFrame } from '@/components/chat/embedded-chat-frame'

export default async function EmbeddedChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ locale?: string }>
}) {
  const { token } = await params
  const { locale } = await searchParams

  return <EmbeddedChatFrame token={token} localeOverride={locale} />
}
