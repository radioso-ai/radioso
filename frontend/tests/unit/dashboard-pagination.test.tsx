import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DashboardPagination } from '@/components/dashboard/shared/dashboard-pagination'

describe('DashboardPagination', () => {
  it('renders navigation links and status text when multiple pages are available', () => {
    const html = renderToStaticMarkup(
      <DashboardPagination
        summary="Showing 11-20 of 37 items"
        currentPage={2}
        totalPages={4}
        previousHref="/account/acme/history?page=1"
        nextHref="/account/acme/history?page=3"
      />,
    )

    expect(html).toContain('Showing 11-20 of 37 items')
    expect(html).toContain('Page 2 of 4')
    expect(html).toContain('href="/account/acme/history?page=1"')
    expect(html).toContain('href="/account/acme/history?page=3"')
  })

  it('disables previous navigation on the first page', () => {
    const html = renderToStaticMarkup(
      <DashboardPagination
        summary="Showing 1-10 of 37 items"
        currentPage={1}
        totalPages={4}
        previousHref="/account/acme/history?page=0"
        nextHref="/account/acme/history?page=2"
      />,
    )

    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('href="/account/acme/history?page=2"')
  })

  it('renders nothing when pagination is unnecessary', () => {
    const html = renderToStaticMarkup(
      <DashboardPagination
        summary="Showing 1-5 of 5 items"
        currentPage={1}
        totalPages={1}
        previousHref="/account/acme/history?page=1"
        nextHref="/account/acme/history?page=1"
      />,
    )

    expect(html).toBe('')
  })
})
