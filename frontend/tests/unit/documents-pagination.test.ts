import { describe, expect, it } from 'vitest'

import { getSafeDocumentsPage } from '@/lib/documents-pagination'

describe('documents pagination state', () => {
  it('preserves the requested page before the first document load completes', () => {
    expect(getSafeDocumentsPage({
      currentPage: 10,
      totalDocuments: 0,
      pageSize: 100,
      hasLoadedDocuments: false,
    })).toBe(10)
  })

  it('clamps the page after loading when the requested page exceeds the available pages', () => {
    expect(getSafeDocumentsPage({
      currentPage: 10,
      totalDocuments: 250,
      pageSize: 100,
      hasLoadedDocuments: true,
    })).toBe(3)
  })
})
