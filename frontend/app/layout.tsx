import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Fraunces } from 'next/font/google'
import { ThemeProvider } from '@/components/theme-provider'
import { FrontendErrorBoundary } from '@/components/frontend-error-boundary'
import { ProductAnalyticsProvider } from '@/components/product-analytics-provider'
import { AuthProvider } from '@/lib/auth-context'
import { WorkspaceProvider } from '@/lib/workspace-context'
import { ChatProvider } from '@/lib/chat-context'
import './globals.css'

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  display: 'swap',
})

export const metadata: Metadata = {
  title: {
    default: 'Radioso',
    template: '%s · Radioso',
  },
  description: 'Self-hosted conversational agents that answer, act, and hand off — inside the rules you author.',
  icons: {
    shortcut: '/favicon.ico',
    icon: '/radioso-icon.svg',
    apple: '/apple-icon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={fraunces.variable} suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <FrontendErrorBoundary>
            <AuthProvider>
              <WorkspaceProvider>
                <ChatProvider>{children}</ChatProvider>
              </WorkspaceProvider>
            </AuthProvider>
          </FrontendErrorBoundary>
          <Suspense fallback={null}>
            <ProductAnalyticsProvider />
          </Suspense>
        </ThemeProvider>
      </body>
    </html>
  )
}
