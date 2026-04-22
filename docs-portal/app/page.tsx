'use client'

import { DocsContent } from '@/components/docs/docs-content'
import { DocsShell } from '@/components/docs/docs-shell'

export default function DocsHomePage() {
  return (
    <DocsShell>
      <DocsContent />
    </DocsShell>
  )
}
