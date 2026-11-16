import { agentsApi } from '@/lib/api'
import { getAgentOperatorLabel, type AgentLabelSource } from '@/lib/agent-label'

/** Announced after the menu renames an agent, so a Profile page that is open can take the new name. */
export const AGENT_RENAMED_EVENT = 'radioso:agent-renamed'

export interface AgentRenamedDetail {
  agentId: string
  field: AgentRenameField
  value: string
}

/**
 * The name the agent menu shows is the internal name when one is set, else the visitor-facing name,
 * so Rename writes the one the menu is showing: renaming never silently edits a field that is hidden
 * behind another.
 */
export type AgentRenameField = 'internalName' | 'name'

export const agentRenameField = (agent: AgentLabelSource): AgentRenameField =>
  agent.internalName?.trim() ? 'internalName' : 'name'

/** What the Rename dialog starts from: the label the menu shows for the agent. */
export const agentRenameInitialValue = (agent: AgentLabelSource): string => getAgentOperatorLabel(agent, '')

/** Writes the new name to the field the menu shows, then tells every open view about it. */
export async function renameAgent(agentId: string, agent: AgentLabelSource, nextName: string): Promise<void> {
  const field = agentRenameField(agent)
  const value = nextName.trim()
  await agentsApi.updateAgent(agentId, { [field]: value })
  window.dispatchEvent(new CustomEvent<AgentRenamedDetail>(AGENT_RENAMED_EVENT, { detail: { agentId, field, value } }))
  window.dispatchEvent(new CustomEvent('radioso:assistant-name-updated', { detail: { agentId } }))
}
