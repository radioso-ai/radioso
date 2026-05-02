export const metadata = {
  title: 'Embedded Chat',
  description: 'Embedded chat',
}

export default function EmbeddedChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <div className="flex h-screen overflow-hidden">{children}</div>
}
