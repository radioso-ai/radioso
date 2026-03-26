'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  type DocumentSearchHistoryEntry,
  type DocumentSearchResponse,
  documentsApi,
} from '@/lib/api'

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  ) {
    return error.error.message
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

export function useDocumentSearch() {
  const [query, setQuery] = useState('')
  const [activeSearch, setActiveSearch] = useState<DocumentSearchResponse | null>(null)
  const [history, setHistory] = useState<DocumentSearchHistoryEntry[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isHistoryLoading, setIsHistoryLoading] = useState(true)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const loadHistory = useCallback(async () => {
    setIsHistoryLoading(true)
    setHistoryError(null)

    try {
      const response = await documentsApi.listSearchHistory({ limit: 25, offset: 0 })
      setHistory(response.searches)
    } catch (error) {
      setHistoryError(getErrorMessage(error, 'Failed to load document search history.'))
    } finally {
      setIsHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const runSearch = useCallback(async (nextQuery?: string) => {
    const trimmed = (nextQuery ?? query).trim()
    if (!trimmed) {
      setActiveSearch(null)
      setSearchError(null)
      return
    }

    setIsSearching(true)
    setSearchError(null)

    try {
      const response = await documentsApi.searchDocuments({ query: trimmed })
      setActiveSearch(response)
      setQuery(trimmed)
      await loadHistory()
    } catch (error) {
      setSearchError(getErrorMessage(error, 'Failed to search documents.'))
    } finally {
      setIsSearching(false)
    }
  }, [loadHistory, query])

  const replaySearch = useCallback(async (searchId: string) => {
    setIsSearching(true)
    setSearchError(null)

    try {
      const response = await documentsApi.getSearchHistory(searchId)
      setActiveSearch(response)
      setQuery(response.query)
    } catch (error) {
      setSearchError(getErrorMessage(error, 'Failed to open document search history.'))
    } finally {
      setIsSearching(false)
    }
  }, [])

  const clearSearch = useCallback(() => {
    setQuery('')
    setActiveSearch(null)
    setSearchError(null)
  }, [])

  return {
    query,
    setQuery,
    activeSearch,
    history,
    isSearching,
    isHistoryLoading,
    searchError,
    historyError,
    runSearch,
    replaySearch,
    clearSearch,
  }
}
