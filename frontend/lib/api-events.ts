import { parseSseEvent } from './api-chat-stream'
import { API_BASE, requireWorkspaceApiToken } from './api-client'

export interface WorkspacePushEvent {
  resourceType: string
  resourceId: string
  workspaceId: string
  changeKind: string
  version: number
}

export interface WorkspaceEventsHandlers {
  onReady: () => void
  onPush: (event: WorkspacePushEvent) => void
}

const INITIAL_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 30_000

const isWorkspacePushEvent = (value: unknown): value is WorkspacePushEvent => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const event = value as Record<string, unknown>
  return (
    typeof event.resourceType === 'string' &&
    typeof event.resourceId === 'string' &&
    typeof event.workspaceId === 'string' &&
    typeof event.changeKind === 'string' &&
    typeof event.version === 'number'
  )
}

const waitForReconnect = (delayMs: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timeoutId = window.setTimeout(resolve, delayMs)
  signal.addEventListener('abort', () => {
    window.clearTimeout(timeoutId)
    resolve()
  }, { once: true })
})

const reconnectDelay = (attempt: number): number => {
  const cappedDelay = Math.min(
    MAX_RECONNECT_DELAY_MS,
    INITIAL_RECONNECT_DELAY_MS * 2 ** attempt,
  )
  return Math.round(cappedDelay * (0.5 + Math.random()))
}

const readWorkspaceEventStream = async (
  response: Response,
  handlers: WorkspaceEventsHandlers,
  signal: AbortSignal,
): Promise<void> => {
  if (!response.body) {
    throw new Error('Workspace event stream body was unavailable.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const cancelReader = () => {
    void reader.cancel()
  }
  signal.addEventListener('abort', cancelReader, { once: true })

  const flush = (rawEvent: string) => {
    if (!rawEvent.trim()) {
      return
    }

    const { eventName, data } = parseSseEvent(rawEvent)
    if (eventName === 'ready') {
      handlers.onReady()
      return
    }

    if (eventName !== 'push' || !data) {
      return
    }

    try {
      const payload: unknown = JSON.parse(data)
      if (isWorkspacePushEvent(payload)) {
        handlers.onPush(payload)
      }
    } catch {
      console.debug('Ignoring malformed workspace push event.')
    }
  }

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })

      let delimiter = buffer.match(/\r?\n\r?\n/)
      while (delimiter?.index !== undefined) {
        flush(buffer.slice(0, delimiter.index))
        buffer = buffer.slice(delimiter.index + delimiter[0].length)
        delimiter = buffer.match(/\r?\n\r?\n/)
      }

      if (done) {
        break
      }
    }

    if (buffer.trim()) {
      flush(buffer)
    }
  } finally {
    signal.removeEventListener('abort', cancelReader)
    void reader.cancel()
  }
}

/**
 * Maintains the dashboard's workspace-scoped invalidation channel until aborted.
 * Callers receive `onReady` for the initial connection and every reconnection.
 */
export const streamWorkspaceEvents = async (
  handlers: WorkspaceEventsHandlers,
  signal: AbortSignal,
): Promise<void> => {
  let reconnectAttempt = 0

  while (!signal.aborted) {
    try {
      const token = await requireWorkspaceApiToken()
      if (signal.aborted) {
        return
      }

      const response = await fetch(`${API_BASE}/events`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Forwarded-Prefix': '/backend',
        },
      })
      if (!response.ok) {
        throw new Error(`Workspace event stream request failed with status ${response.status}.`)
      }

      await readWorkspaceEventStream(response, {
        ...handlers,
        onReady: () => {
          reconnectAttempt = 0
          handlers.onReady()
        },
      }, signal)
    } catch (error) {
      if (signal.aborted) {
        return
      }
      console.debug('Workspace push channel unavailable; continuing with reconcile polling.', error)
    }

    if (signal.aborted) {
      return
    }

    const delayMs = reconnectDelay(reconnectAttempt)
    reconnectAttempt += 1
    console.debug('Reconnecting workspace push channel.', { delayMs })
    await waitForReconnect(delayMs, signal)
  }
}
