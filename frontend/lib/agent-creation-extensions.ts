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

const agentCreationActionsConfigFilename = 'agent-creation-actions.json'
let generatedAgentCreationActionsMissing = false

const builtInAgentCreationActionDefinitions: AgentCreationActionDefinition[] = [
  {
    id: 'website',
    label: 'Create from website',
    icon: 'globe',
    kind: 'wizard-dialog',
  },
]

const mergeAgentCreationActionDefinitions = (
  builtIns: readonly AgentCreationActionDefinition[],
  loaded: readonly AgentCreationActionDefinition[],
): AgentCreationActionDefinition[] => {
  const definitions = new Map<string, AgentCreationActionDefinition>()
  for (const definition of builtIns) {
    definitions.set(definition.id, definition)
  }
  for (const definition of loaded) {
    definitions.set(definition.id, definition)
  }
  return [...definitions.values()]
}

const normalizeBasePath = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') return ''
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeadingSlash.endsWith('/') ? withLeadingSlash.slice(0, -1) : withLeadingSlash
}

const inferAppBasePath = (): string => {
  const configured = process.env.NEXT_PUBLIC_BASE_PATH
  if (configured) {
    return normalizeBasePath(configured)
  }

  const nextScript = document.querySelector<HTMLScriptElement>('script[src*="/_next/"]')
  const scriptSrc = nextScript?.getAttribute('src')
  if (!scriptSrc) {
    return ''
  }

  try {
    const pathname = new URL(scriptSrc, window.location.href).pathname
    const nextIndex = pathname.indexOf('/_next/')
    return nextIndex > 0 ? pathname.slice(0, nextIndex) : ''
  } catch {
    return ''
  }
}

export const getAgentCreationActionsConfigPath = (): string =>
  `${inferAppBasePath()}/${agentCreationActionsConfigFilename}`

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
    return builtInAgentCreationActionDefinitions
  }
  if (generatedAgentCreationActionsMissing) {
    return builtInAgentCreationActionDefinitions
  }
  try {
    const response = await fetch(getAgentCreationActionsConfigPath(), { cache: 'no-store' })
    if (!response.ok) {
      if (response.status === 404) {
        generatedAgentCreationActionsMissing = true
      }
      return builtInAgentCreationActionDefinitions
    }
    return mergeAgentCreationActionDefinitions(
      builtInAgentCreationActionDefinitions,
      parseAgentCreationActionDefinitions(await response.json()),
    )
  } catch {
    return builtInAgentCreationActionDefinitions
  }
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
      // Feature availability (presence of the action definition) is the
      // visibility gate; workspace-key readiness is checked at click and
      // render time. This keeps the entrypoint visible during transient
      // states where the workspace is still loading.
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
