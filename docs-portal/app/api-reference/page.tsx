import type { Metadata } from 'next'
import Script from 'next/script'

export const metadata: Metadata = {
  title: 'API Reference',
  description: 'Interactive REST API reference for Radioso.',
}

export default function ApiReferencePage() {
  return (
    <>
      <Script src="/vendor/stoplight/web-components.min.js" strategy="afterInteractive" />
      <div className="h-full w-full">
        {/* @ts-expect-error custom element registered by /vendor/stoplight/web-components.min.js */}
        <elements-api
          apiDescriptionUrl="/openapi.json"
          router="hash"
          layout="sidebar"
        />
      </div>
    </>
  )
}
