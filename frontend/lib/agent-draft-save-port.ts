/**
 * Narrow bridge between the agent editor, which owns draft persistence, and
 * consumers such as Test Chat that need to save before starting an execution.
 *
 * The registry is intentionally process-local and keyed by agent. A consumer
 * can only succeed when the mounted editor has registered its real async save
 * operation; it cannot manufacture a saved state by dispatching an event.
 */
type AgentDraftSaver = {
  save: () => Promise<void>
  isDirty: () => boolean
}

const savers = new Map<string, AgentDraftSaver>()

export function registerAgentDraftSaver(agentId: string, saver: AgentDraftSaver): () => void {
  savers.set(agentId, saver)
  return () => {
    if (savers.get(agentId) === saver) {
      savers.delete(agentId)
    }
  }
}

export async function saveAgentDraft(agentId: string): Promise<void> {
  const saver = savers.get(agentId)
  if (!saver) {
    throw new Error('The agent editor is not ready to save this draft.')
  }
  await saver.save()
}

export function isAgentDraftDirty(agentId: string): boolean {
  return savers.get(agentId)?.isDirty() ?? false
}
