import type { Metadata } from 'next'
import Script from 'next/script'
import { ThemeProvider } from '@/components/theme-provider'
import { AuthProvider } from '@/lib/auth-context'
import { WorkspaceProvider } from '@/lib/workspace-context'
import { ChatProvider } from '@/lib/chat-context'
import './globals.css'

const themeBootstrapScript = `
(() => {
  try {
    const storedTheme = window.localStorage.getItem('theme')
    const theme =
      storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system'
        ? storedTheme
        : 'system'
    const resolvedTheme =
      theme === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : theme
    const root = document.documentElement
    root.classList.toggle('dark', resolvedTheme === 'dark')
    root.style.colorScheme = resolvedTheme
  } catch {}
})()
`

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
        <Script id="theme-bootstrap" strategy="beforeInteractive">
          {themeBootstrapScript}
        </Script>
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
