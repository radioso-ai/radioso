import { getPageMap } from 'nextra/page-map'

import { DocsFooter } from '@/components/docs/docs-footer'
import { DocsHeader } from '@/components/docs/docs-header'
import { DocsNavProvider } from '@/components/docs/docs-nav'
import { DocsPageBody } from '@/components/docs/docs-page-body'
import { DocsSidebar } from '@/components/docs/docs-sidebar'

export const MAIN_CONTENT_ID = 'docs-main-content'

/**
 * Server component: the page map can only be read on the server, so it is
 * fetched once here and handed to the client navigation as plain data.
 */
export async function DocsShell({
  children,
  contentClassName,
}: {
  children: React.ReactNode
  contentClassName?: string
}) {
  const pageMap = await getPageMap()

  return (
    <DocsNavProvider pageMap={pageMap}>
      <a
        href={`#${MAIN_CONTENT_ID}`}
        className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <div className="flex min-h-screen bg-background">
        <DocsSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <DocsHeader />
          <main id={MAIN_CONTENT_ID} tabIndex={-1} className="min-w-0 flex-1 outline-none">
            <DocsPageBody contentId={MAIN_CONTENT_ID} className={contentClassName}>
              {children}
            </DocsPageBody>
          </main>
          <DocsFooter />
        </div>
      </div>
    </DocsNavProvider>
  )
}
