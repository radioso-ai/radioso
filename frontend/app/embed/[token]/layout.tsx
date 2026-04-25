import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Embedded Chat',
  description: 'Embedded chat with our AI assistant',
}

export default function EmbeddedChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex h-screen overflow-hidden">{children}</div>
  )
}
