import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * What a settled row mutation is allowed to do.
 *
 * `stale` means the scope moved on while the request was in flight — the settings section it was
 * started from is now showing a different subject, so the response describes a list that is no
 * longer on screen and must not be applied to the one that is.
 */
export type RowMutationOutcome<T> =
  | { status: 'applied'; value: T }
  | { status: 'failed'; error: unknown }
  | { status: 'stale' }

export interface ScopedRowMutations {
  isPending: (rowId: string) => boolean
  run: <T>(rowId: string, mutate: () => Promise<T>) => Promise<RowMutationOutcome<T>>
}

const NO_ROWS: ReadonlySet<string> = new Set()

type PendingRows = { scopeKey: string; rowIds: ReadonlySet<string> }

/**
 * Per-row mutation state for a settings list whose rows can each be changed in place.
 *
 * A section-level save protocol (`useSettingsSaveStatus`) is single-flight by design: a dialog has
 * one save in flight, and a newer save supersedes an older one. A row control breaks both
 * assumptions — an operator can act on two rows before either request returns, and the second
 * action does not make the first one's result untrue. Borrowing the single-flight protocol for a
 * row control therefore drops committed responses and strands row locks, so rows get their own
 * primitive rather than a reinterpretation of that one.
 *
 * Three separate questions, each answered here once:
 *
 * - **Is this row busy?** Per row, so one row's request never disables another's control.
 * - **May this response be applied?** Only the scope decides. A concurrent mutation on another row
 *   is irrelevant to whether this one committed.
 * - **When is the row released?** Always, as soon as its own request settles — a scope change or a
 *   later mutation elsewhere must not leave a control disabled with nothing outstanding.
 *
 * `scopeKey` is whatever identifies the subject the list belongs to (an agent id, a workspace id).
 * Pending rows are held against the scope that started them and read back only while that scope is
 * still current, so a scope change releases every lock by derivation rather than by a reset that
 * has to remember to run.
 *
 * The section still owns how a settled mutation is *reported* — this hook deliberately says nothing
 * about save-state chips or error banners, which remain single-flight concerns of the section.
 */
export const useScopedRowMutations = (scopeKey: string): ScopedRowMutations => {
  const [pending, setPending] = useState<PendingRows>(() => ({ scopeKey, rowIds: NO_ROWS }))
  // The latest scope, readable from an async continuation that closed over an older render.
  const scopeRef = useRef(scopeKey)
  useEffect(() => {
    scopeRef.current = scopeKey
  }, [scopeKey])

  const activeRowIds = useMemo(
    () => (pending.scopeKey === scopeKey ? pending.rowIds : NO_ROWS),
    [pending, scopeKey],
  )

  const isPending = useCallback((rowId: string) => activeRowIds.has(rowId), [activeRowIds])

  const run = useCallback(async <T,>(rowId: string, mutate: () => Promise<T>): Promise<RowMutationOutcome<T>> => {
    const requestScope = scopeRef.current
    setPending((current) => (current.scopeKey === requestScope
      ? (current.rowIds.has(rowId) ? current : { scopeKey: requestScope, rowIds: new Set(current.rowIds).add(rowId) })
      : { scopeKey: requestScope, rowIds: new Set([rowId]) }))
    try {
      const value = await mutate()
      return scopeRef.current === requestScope ? { status: 'applied', value } : { status: 'stale' }
    } catch (error) {
      return scopeRef.current === requestScope ? { status: 'failed', error } : { status: 'stale' }
    } finally {
      setPending((current) => {
        if (current.scopeKey !== requestScope || !current.rowIds.has(rowId)) return current
        const rowIds = new Set(current.rowIds)
        rowIds.delete(rowId)
        return { scopeKey: current.scopeKey, rowIds }
      })
    }
  }, [])

  return { isPending, run }
}
