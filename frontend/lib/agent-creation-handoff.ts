export const AGENT_CREATION_HANDOFF_STORAGE_KEY = 'radioso.agentCreation.lastHandoff'

export interface AgentCreationHandoffItem {
  title: string | null
  url: string
}

export interface AgentCreationHandoff {
  agentId: string
  title: string
  description: string
  items: AgentCreationHandoffItem[]
  createdAt: number
}

export const readAgentCreationHandoff = (agentId: string | undefined): AgentCreationHandoff | null => {
  if (!agentId || typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.sessionStorage.getItem(AGENT_CREATION_HANDOFF_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AgentCreationHandoff>
    if (
      parsed.agentId !== agentId ||
      typeof parsed.title !== 'string' ||
      typeof parsed.description !== 'string' ||
      !Array.isArray(parsed.items)
    ) {
      return null
    }
    return {
      agentId,
      title: parsed.title,
      description: parsed.description,
      items: parsed.items
        .filter((item): item is AgentCreationHandoffItem => Boolean(item) && typeof item.url === 'string')
        .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index),
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    }
  } catch {
    return null
  }
}

export const clearAgentCreationHandoff = () => {
  window.sessionStorage.removeItem(AGENT_CREATION_HANDOFF_STORAGE_KEY)
}
