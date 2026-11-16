/**
 * Recovery from a chunk that no longer exists.
 *
 * A deploy replaces the container that serves `/_next/static/chunks/*`, so a page that was open
 * across the deploy asks for a chunk the new build never had. The page's own HTML is the old
 * build; fetching it again is the fix, and the only one.
 *
 * The guard against a reload loop is a timestamp in the reloaded address, not Web Storage:
 * storage throws `SecurityError` in a third-party frame when the browser blocks third-party
 * cookies, which is where the website embed runs. A failure on an address that carries a fresh
 * marker means the reload did not fix it, so the caller falls through to its error fallback.
 */

export const CHUNK_RELOAD_PARAM = 'radioso_chunk_reload'

/**
 * A marker younger than this means the reload that wrote it has not fixed the failure. Older
 * means the page ran fine after the reload and a later deploy broke it again.
 */
export const CHUNK_RELOAD_GUARD_WINDOW_MS = 60_000

// Webpack and Turbopack both throw the failure with this name, for script and stylesheet chunks
// alike, and the app has no `import()` that bypasses them, so no browser-native import failure
// (whose message text differs per engine) can reach us.
const CHUNK_LOAD_ERROR_NAME = 'ChunkLoadError'

// A wrapper such as `new Error('render failed', { cause })` keeps the original failure one level
// down. The cap also ends a cause chain that points back at itself.
const MAX_CAUSE_DEPTH = 5

export const isChunkLoadFailure = (error: unknown): boolean => {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false
    if ((current as { name?: unknown }).name === CHUNK_LOAD_ERROR_NAME) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

type ChunkLoadRecoveryPlan =
  | { kind: 'reload'; url: string }
  | { kind: 'skip'; reason: 'not_chunk_failure' | 'reload_already_attempted' | 'unusable_url' }

interface ChunkLoadRecoveryInput {
  error: unknown
  /** The address the failing page is on, as `window.location.href` reports it. */
  href: string
  /** Epoch milliseconds. */
  now: number
}

const parseUrl = (href: string): URL | null => {
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

const markerOf = (queryEntries: string[]): string | undefined => {
  const prefix = `${CHUNK_RELOAD_PARAM}=`
  return queryEntries.find((entry) => entry.startsWith(prefix))?.slice(prefix.length)
}

// A marker from the future counts as fresh, so a clock that moved backwards cannot start a loop.
const isFreshMarker = (value: string | undefined, now: number): boolean => {
  if (value === undefined || !/^\d+$/u.test(value)) return false
  return now - Number(value) < CHUNK_RELOAD_GUARD_WINDOW_MS
}

export const planChunkLoadRecovery = ({ error, href, now }: ChunkLoadRecoveryInput): ChunkLoadRecoveryPlan => {
  if (!isChunkLoadFailure(error)) return { kind: 'skip', reason: 'not_chunk_failure' }

  const url = parseUrl(href)
  if (!url) return { kind: 'skip', reason: 'unusable_url' }

  // The query is edited as raw text. Round-tripping it through `URLSearchParams` would re-encode
  // values such as the embed's JSON `copy` and `theme` parameters.
  const entries = url.search.slice(1).split('&').filter((entry) => entry !== '')
  if (isFreshMarker(markerOf(entries), now)) return { kind: 'skip', reason: 'reload_already_attempted' }

  const kept = entries.filter((entry) => entry !== CHUNK_RELOAD_PARAM && !entry.startsWith(`${CHUNK_RELOAD_PARAM}=`))
  url.search = `?${[...kept, `${CHUNK_RELOAD_PARAM}=${now}`].join('&')}`
  return { kind: 'reload', url: url.toString() }
}
