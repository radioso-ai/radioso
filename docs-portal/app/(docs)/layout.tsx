import { DocsShell } from '@/components/docs/docs-shell'

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <DocsShell contentClassName="docs-mdx-shell">{children}</DocsShell>
}
