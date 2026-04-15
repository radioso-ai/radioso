import { EmbeddedChatFrame } from '@/components/chat/embedded-chat-frame'

export default async function EmbeddedChatPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  return <EmbeddedChatFrame token={token} />
}
