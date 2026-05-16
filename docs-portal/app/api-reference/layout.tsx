import type { ReactNode } from 'react'

import '@stoplight/elements/styles.min.css'

import { DocsHeader } from '@/components/docs/docs-header'

export default function ApiReferenceLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <DocsHeader />
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  )
}
