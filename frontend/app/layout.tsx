import type { Metadata } from 'next'
import { ThemeProvider } from '@/components/theme-provider'
import { AuthProvider } from '@/lib/auth-context'
import { WorkspaceProvider } from '@/lib/workspace-context'
import { ChatProvider } from '@/lib/chat-context'
import './globals.css'

export const metadata: Metadata = {
  title: 'radioso - Modular RAG Platform',
  description: 'A modular retrieval-augmented generation platform for intelligent document Q&A',
  icons: {
    icon: '/radioso-logo.png',
    apple: '/radioso-logo.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AuthProvider>
            <WorkspaceProvider>
              <ChatProvider>{children}</ChatProvider>
            </WorkspaceProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
