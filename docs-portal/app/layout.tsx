import type { Metadata } from 'next'
import { Fraunces, Inter, JetBrains_Mono } from 'next/font/google'
import Script from 'next/script'
import 'nextra-theme-docs/style.css'

import { ThemeProvider } from '@/components/theme-provider'
import { ogImage, site } from '@/lib/site'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
})

// Display face shared with the marketing site and the product dashboard.
const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL(site.docsUrl),
  title: {
    default: site.name,
    template: `%s | ${site.name}`,
  },
  description: site.description,
  applicationName: site.name,
  alternates: {
    canonical: site.docsUrl,
  },
  openGraph: {
    type: 'website',
    title: site.name,
    description: site.description,
    url: site.docsUrl,
    siteName: site.name,
    images: [ogImage],
  },
  twitter: {
    card: 'summary_large_image',
    title: site.name,
    description: site.description,
    images: [ogImage],
  },
  icons: {
    shortcut: '/favicon.ico',
    icon: '/radioso-icon.svg',
    apple: '/apple-icon.png',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The font variables live on <html> so they are declared on the same element
    // as :root. `@theme` resolves `--font-display` there; if `--font-fraunces`
    // were only on <body>, the theme variable would be invalid at computed-value
    // time and every `font-family: var(--font-display)` rule would silently fall
    // back to the sans stack.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} ${fraunces.variable} bg-background`}
    >
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
        <Script
          src="https://app.radioso.ai/radioso-embed.js"
          data-radioso-token={site.embedToken}
          strategy="afterInteractive"
        />
      </body>
    </html>
  )
}
