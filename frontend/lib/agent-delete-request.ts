/**
 * The agent menu asks for the delete confirmation by event, because the confirmation lives in the
 * agent view, which stays mounted when the sidebar that holds the menu is closed on a small screen.
 */
export const AGENT_DELETE_REQUESTED_EVENT = 'radioso:agent-delete-requested'

export const requestAgentDelete = (agentId: string): void => {
  window.dispatchEvent(new CustomEvent<{ agentId: string }>(AGENT_DELETE_REQUESTED_EVENT, { detail: { agentId } }))
}
