export type AgentCreationActionKind = 'route' | 'wizard-dialog'

export interface AgentCreationAction {
  id: string
  label: string
  href: string | null
  icon: 'globe'
  kind: AgentCreationActionKind
}

export interface AgentCreationActionDefinition {
  id: string
  label: string
  hrefTemplate?: string
  icon: 'globe'
  kind?: AgentCreationActionKind
}

export interface AgentCreationActionContext {
  accountId: string
  workspacePublicRouteKey?: string | null
}

const agentCreationActionsConfigPath = '/enterprise-agent-creation-actions.json'
let definitionsPromise: Promise<AgentCreationActionDefinition[]> | null = null

export const parseAgentCreationActionDefinitions = (payload: unknown): AgentCreationActionDefinition[] => {
  const actions = payload && typeof payload === 'object' && 'actions' in payload
    ? (payload as { actions?: unknown }).actions
    : null
  if (!Array.isArray(actions)) {
    return []
  }
  return actions.filter((action): action is AgentCreationActionDefinition => {
    if (!action || typeof action !== 'object') return false
    const typed = action as AgentCreationActionDefinition
    if (typeof typed.id !== 'string' || typeof typed.label !== 'string' || typed.icon !== 'globe') {
      return false
    }
    const kind = typed.kind ?? 'route'
    if (kind === 'route') {
      return typeof typed.hrefTemplate === 'string'
    }
    return kind === 'wizard-dialog'
  })
}

export const loadAgentCreationActionDefinitions = async (): Promise<AgentCreationActionDefinition[]> => {
  if (typeof window === 'undefined') {
    return []
  }
  definitionsPromise ??= fetch(agentCreationActionsConfigPath, { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) {
        return []
      }
      return parseAgentCreationActionDefinitions(await response.json())
    })
    .catch(() => [])
  return definitionsPromise
}

export const resolveAgentCreationActions = (
  definitions: readonly AgentCreationActionDefinition[],
  {
    accountId,
    workspacePublicRouteKey,
  }: AgentCreationActionContext,
): AgentCreationAction[] =>
  definitions.flatMap((definition): AgentCreationAction[] => {
    const kind = definition.kind ?? 'route'
    if (kind === 'wizard-dialog') {
      // The wizard navigates to the agent settings page after creation,
      // which requires the workspace public route key. Hide the action
      // entirely until that key is available rather than rendering a
      // button that opens a dialog state nothing renders for.
      if (!workspacePublicRouteKey) {
        return []
      }
      return [{
        id: definition.id,
        label: definition.label,
        href: null,
        icon: definition.icon,
        kind,
      }]
    }
    const hrefTemplate = definition.hrefTemplate
    if (typeof hrefTemplate !== 'string') {
      return []
    }
    if (hrefTemplate.includes('{workspacePublicRouteKey}') && !workspacePublicRouteKey) {
      return []
    }
    const href = hrefTemplate
      .replaceAll('{accountId}', encodeURIComponent(accountId))
      .replaceAll('{workspacePublicRouteKey}', encodeURIComponent(workspacePublicRouteKey ?? ''))
    if (!href.startsWith('/')) {
      return []
    }
    return [{
      id: definition.id,
      label: definition.label,
      href,
      icon: definition.icon,
      kind,
    }]
  })
