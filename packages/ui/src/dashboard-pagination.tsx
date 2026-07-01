'use client'

import * as React from 'react'

import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from './pagination'

const shouldInterceptPaginationClick = (event: React.MouseEvent<HTMLAnchorElement>) =>
  event.button === 0 &&
  !event.defaultPrevented &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey

export function DashboardPagination({
  summary,
  currentPage,
  totalPages,
  previousHref,
  nextHref,
  onPrevious,
  onNext,
  canPrevious = currentPage > 1,
  canNext = currentPage < totalPages,
}: {
  summary?: React.ReactNode
  currentPage: number
  totalPages: number
  previousHref: string
  nextHref: string
  onPrevious?: () => void
  onNext?: () => void
  canPrevious?: boolean
  canNext?: boolean
}) {
  if (totalPages <= 1) {
    return null
  }

  const previousDisabled = !canPrevious
  const nextDisabled = !canNext

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      {summary ? (
        <p className="text-sm text-muted-foreground">{summary}</p>
      ) : null}
      <Pagination className="mx-0 w-auto justify-start sm:ml-auto sm:justify-end">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href={previousHref}
              onClick={(event) => {
                if (previousDisabled) {
                  event.preventDefault()
                  return
                }

                if (onPrevious && shouldInterceptPaginationClick(event)) {
                  event.preventDefault()
                  onPrevious?.()
                }
              }}
              aria-disabled={previousDisabled}
              className={previousDisabled ? 'pointer-events-none opacity-50' : undefined}
            />
          </PaginationItem>
          <PaginationItem>
            <span className="px-3 text-sm text-muted-foreground">
              Page {currentPage} of {totalPages}
            </span>
          </PaginationItem>
          <PaginationItem>
            <PaginationNext
              href={nextHref}
              onClick={(event) => {
                if (nextDisabled) {
                  event.preventDefault()
                  return
                }

                if (onNext && shouldInterceptPaginationClick(event)) {
                  event.preventDefault()
                  onNext?.()
                }
              }}
              aria-disabled={nextDisabled}
              className={nextDisabled ? 'pointer-events-none opacity-50' : undefined}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
