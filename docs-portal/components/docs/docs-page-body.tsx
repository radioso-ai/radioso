'use client'

import type { ReactNode } from 'react'

import { DocsBreadcrumbs } from '@/components/docs/docs-breadcrumbs'
import { useDocsNav } from '@/components/docs/docs-nav'
import { DocsPagination } from '@/components/docs/docs-pagination'
import { DocsToc } from '@/components/docs/docs-toc'
import { cn } from '@radioso/ui/utils'

/**
 * Page chrome shared by every docs route: breadcrumbs, the right-rail table of
 * contents and prev/next pagination. What renders is driven by the page theme
 * declared in `content/**\/_meta.js`, so a page opts out through its meta entry
 * rather than through a special case here.
 */
export function DocsPageBody({
  children,
  contentId,
  className,
}: {
  children: ReactNode
  contentId: string
  className?: string
}) {
  const nav = useDocsNav()
  const theme = nav?.activeThemeContext
  const isFullLayout = theme?.layout === 'full'
  const showBreadcrumbs = !isFullLayout && theme?.breadcrumb !== false
  const showToc = !isFullLayout && theme?.toc !== false

  return (
    <div
      className={cn(
        // Below `xl` the contents rail is hidden, so the text column centres
        // instead of hugging the left edge of a much wider container.
        'mx-auto flex w-full justify-center gap-6 xl:justify-between xl:gap-10',
        isFullLayout ? 'max-w-5xl' : 'max-w-6xl',
      )}
    >
      {/* `contentClassName` carries the readable measure and prose rules from
          `app/globals.css`. It has to stay on the element that also owns the
          horizontal gutters — the measure is `max-width` minus those gutters —
          so it cannot move to the row that holds the contents rail. */}
      <div className={cn('min-w-0 flex-1 px-5 py-10 sm:px-8 lg:py-14', className)}>
        {showBreadcrumbs ? <DocsBreadcrumbs /> : null}
        {children}
        <DocsPagination />
      </div>
      {showToc ? (
        <div className="hidden py-10 pe-5 sm:pe-8 lg:py-14 xl:block">
          <DocsToc contentId={contentId} />
        </div>
      ) : null}
    </div>
  )
}
