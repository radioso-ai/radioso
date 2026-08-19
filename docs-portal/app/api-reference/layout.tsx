import type { ReactNode } from 'react'

import '@stoplight/elements/styles.min.css'

import { DocsFooter } from '@/components/docs/docs-footer'
import { DocsHeader } from '@/components/docs/docs-header'

export default function ApiReferenceLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <DocsHeader />
      {/* Stoplight Elements manages its own internal scrolling, which only works
          against a definite height. The wrapper is `min-h-screen` so the footer
          can sit below it, and a `min-height` container gives its children no
          definite height to flex into — so the pane is sized explicitly here
          instead of with `flex-1`, whose `flex-basis: 0%` would win over any
          height in a column flex container. */}
      <main className="flex min-h-0 flex-col overflow-hidden [block-size:calc(100dvh-5.5rem)]">
        {children}
      </main>
      <DocsFooter />
    </div>
  )
}
