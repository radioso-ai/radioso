/** The first retry waits up to this long; each later one up to twice the one before. */
const FIRST_RETRY_CEILING_MS = 1_000
/** A tail read that keeps failing is retried this many times, then left to the stream's next event. */
const MAX_RETRIES = 5

/**
 * How long to wait before retrying a visitor's failed tail read, given how many reads in a row
 * have already failed, or null once the retries are spent. Each wait is drawn between half and all
 * of a doubling ceiling, so the visitors whose reads failed together, when the server's database
 * listener reconnects say, retry spread out.
 */
export function tailRefreshRetryDelayMs(failuresSoFar: number, random: () => number = Math.random): number | null {
  if (failuresSoFar >= MAX_RETRIES) {
    return null
  }
  const ceiling = FIRST_RETRY_CEILING_MS * 2 ** failuresSoFar
  return Math.round(ceiling * (0.5 + 0.5 * random()))
}

interface TailRefresherOptions {
  /**
   * Reads the conversation's new messages; `includeSnapshot` asks it to load the conversation first
   * when nothing has been read yet. `isStopped` turns true once the conversation is left.
   */
  read(includeSnapshot: boolean, isStopped: () => boolean): Promise<void>
  /** Whether a failed read means the conversation is gone, so retrying cannot help. */
  isGone(error: unknown): boolean
  onGone(): void
  random?: () => number
}

/**
 * The visitor's reads of a conversation's tail, one at a time in the order the event stream asked
 * for them. A `ready` or `message.created` is how a new message reaches the visitor only through the
 * read it sets off, so a read that fails is retried with backoff rather than dropped.
 */
export function createTailRefresher(options: TailRefresherOptions) {
  let stopped = false
  let chain = Promise.resolve()
  let failures = 0
  let retryTimer: number | null = null
  const isStopped = () => stopped

  const clearRetry = () => {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const retryLater = (error: unknown, includeSnapshot: boolean) => {
    if (stopped) {
      return
    }
    if (options.isGone(error)) {
      options.onGone()
      return
    }
    const delay = tailRefreshRetryDelayMs(failures, options.random)
    if (delay === null) {
      failures = 0
      return
    }
    failures += 1
    clearRetry()
    retryTimer = window.setTimeout(() => {
      retryTimer = null
      refresh(includeSnapshot)
    }, delay)
  }

  function refresh(includeSnapshot: boolean) {
    chain = chain
      .then(async () => {
        if (stopped) {
          return
        }
        await options.read(includeSnapshot, isStopped)
        failures = 0
        clearRetry()
      })
      .catch((error: unknown) => retryLater(error, includeSnapshot))
  }

  return {
    refresh,
    stop() {
      stopped = true
      clearRetry()
    },
  }
}
