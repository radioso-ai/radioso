import { DocsContent } from '@/components/docs/docs-content'
import { DocsShell } from '@/components/docs/docs-shell'
import { releaseLine } from '@/lib/release'

export default function DocsHomePage() {
  return (
    <DocsShell>
      <DocsContent releaseLine={releaseLine} />
    </DocsShell>
  )
}
