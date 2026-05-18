import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import Script from 'next/script'
import 'nextra-theme-docs/style.css'

import { ThemeProvider } from '@/components/theme-provider'
import { site } from '@/lib/site'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
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
    title: site.name,
    description: site.description,
    url: site.docsUrl,
    siteName: site.name,
    images: [{ url: '/radioso-lockup.svg', width: 983, height: 300, alt: 'Radioso' }],
  },
  icons: {
    icon: '/radioso-icon.svg',
    apple: '/apple-icon.png',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className="bg-background">
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
        <Script
          src="https://platform.radioso.dev/radioso-embed.js"
          data-radioso-token="--kUGFPoIm-fe1Mg2Lvrlw"
          strategy="afterInteractive"
        />
      </body>
    </html>
  )
}
