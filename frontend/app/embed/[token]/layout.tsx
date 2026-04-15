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
    <div className="flex h-screen overflow-hidden bg-background">
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  )
}
