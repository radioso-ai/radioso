/**
 * Narrow bridge between the agent editor, which owns draft persistence, and
 * consumers such as Test Chat that need to save before starting an execution.
 *
 * The registry is intentionally process-local and keyed by agent. A consumer
 * can only succeed when the mounted editor has registered its real async save
 * operation; it cannot manufacture a saved state by dispatching an event.
 */
/**
 * Sent on the window, with `{ agentId }`, after the agent's draft is saved or a revision of it is
 * published, so what reads the draft or the publication reads it again.
 */
export const AGENT_DRAFT_SAVED_EVENT = 'radioso:agent-draft-saved'

/**
 * Sent on the window, with `{ agentId }`, after something other than the agent page's own save
 * wrote the agent's draft greeting (Ray applying a greeting proposal), so an open greeting editor
 * reads it again. The page's own save does not send it: the editor already holds what it saved.
 */
export const AGENT_GREETING_CHANGED_EVENT = 'radioso:agent-greeting-changed'

/**
 * Announces a greeting write that did not come from the agent page's own save. The draft moved
 * too, so the revision header and Test Chat are told through {@link AGENT_DRAFT_SAVED_EVENT}.
 */
export function announceAgentGreetingChanged(agentId: string): void {
  window.dispatchEvent(new CustomEvent(AGENT_GREETING_CHANGED_EVENT, { detail: { agentId } }))
  window.dispatchEvent(new CustomEvent(AGENT_DRAFT_SAVED_EVENT, { detail: { agentId } }))
}

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
