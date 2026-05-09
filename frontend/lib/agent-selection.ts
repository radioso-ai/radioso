const LAST_AGENT_STORAGE_KEY = 'radioso.lastAgentByWorkspace'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const readLastAgentMap = (): Record<string, string> => {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(LAST_AGENT_STORAGE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter((entry): entry is [string, string] =>
            typeof entry[0] === 'string' &&
            typeof entry[1] === 'string' &&
            UUID_PATTERN.test(entry[1]),
          ),
        )
      : {}
  } catch {
    return {}
  }
}

export const getLastSelectedAgentId = (workspaceId?: string | null): string | null => {
  if (!workspaceId) {
    return null
  }

  return readLastAgentMap()[workspaceId] ?? null
}

export const setLastSelectedAgentId = (workspaceId?: string | null, agentId?: string | null) => {
  if (typeof window === 'undefined' || !workspaceId || !agentId || !UUID_PATTERN.test(agentId)) {
    return
  }

  const current = readLastAgentMap()
  window.localStorage.setItem(LAST_AGENT_STORAGE_KEY, JSON.stringify({
    ...current,
    [workspaceId]: agentId,
  }))
}
