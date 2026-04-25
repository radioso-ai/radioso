import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Chat',
  description: 'Chat with our AI assistant',
}

export default function PublicChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex h-screen flex-col">{children}</div>
  )
}
