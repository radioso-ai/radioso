import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'API Reference',
  description: 'Interactive REST API reference for Radioso.',
}

export default function ApiReferencePage() {
  const scenarioLinks = [
    { href: '/api/auth-and-sessions', label: 'Auth and sessions' },
    { href: '/api/workspaces-and-tokens', label: 'Workspaces and tokens' },
    { href: '/api/documents-and-search', label: 'Documents and search' },
    { href: '/api/chat-and-history', label: 'Chat and history' },
    { href: '/api/public-chat-and-embed', label: 'Public chat and embed' },
    { href: '/api/settings', label: 'Settings' },
    { href: '/api/connectors-and-webhooks', label: 'Connectors and webhooks' },
  ]

  return (
    <div className="-mx-2 space-y-8">
      <section className="space-y-4 px-2">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">API Reference</h1>
        <p className="max-w-3xl text-base leading-7 text-muted-foreground">
          This page renders the live OpenAPI document from `backend/openapi.json`. Use it for exact request and response schemas. Use the API scenario pages when you want the workflow around those endpoints.
        </p>
        <div className="flex flex-wrap gap-3">
          {scenarioLinks.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              {item.label}
            </Link>
          ))}
        </div>
      </section>
      <div className="overflow-hidden rounded-3xl border border-border bg-card">
        <iframe
          title="Radioso API Reference"
          src="/api-reference/render"
          className="h-[calc(100vh-10rem)] w-full border-0"
        />
      </div>
    </div>
  )
}
