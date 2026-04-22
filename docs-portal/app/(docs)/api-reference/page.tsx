import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'API Reference',
  description: 'Interactive REST API reference for Radioso.',
}

export default function ApiReferencePage() {
  return (
    <div className="-mx-8 -my-14">
      <div className="border-y border-border bg-card">
        <iframe
          title="Radioso API Reference"
          src="/api-reference/render"
          className="h-[calc(100vh-4rem)] w-full border-0"
        />
      </div>
    </div>
  )
}
