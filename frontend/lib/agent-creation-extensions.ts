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

const agentCreationActionsConfigFilename = 'enterprise-agent-creation-actions.json'

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

// Each call performs a fresh fetch with cache: 'no-store'. The previous
// module-level singleton cached the first response for the lifetime of the
// page, which meant transitioning OSS → EE (or changing the EE manifest)
// required a hard reload. Caller-side memoization (in React hooks) is the
// right scope for caching this; the loader stays stateless.
export const loadAgentCreationActionDefinitions = async (): Promise<AgentCreationActionDefinition[]> => {
  if (typeof window === 'undefined') {
    return []
  }
  try {
    const response = await fetch(getAgentCreationActionsConfigPath(), { cache: 'no-store' })
    if (!response.ok) {
      return []
    }
    return parseAgentCreationActionDefinitions(await response.json())
  } catch {
    return []
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
