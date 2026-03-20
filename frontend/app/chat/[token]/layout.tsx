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
    <div className="flex h-screen flex-col items-center justify-center bg-background">
      <div className="flex h-full w-full max-w-4xl flex-col">
        {children}
      </div>
    </div>
  )
}
