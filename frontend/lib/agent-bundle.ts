/**
 * Pure reading of an agent bundle file, kept out of the transport and the
 * component so the parsing rules are testable on their own.
 *
 * The dashboard shows the operator what a file contains *before* it creates an
 * agent from it. Import is not reversible from the import dialog, so "you are
 * about to create this" has to be answerable without a round trip.
 */

export const AGENT_BUNDLE_SCHEMA_VERSION = 1

export type AgentBundleUnresolvedKind =
  | 'context_variable_missing'
  | 'resolver_skill_missing'
  | 'skill_target_unbound'
  | 'skill_capability_unknown'
  | 'routine_invalid'
  | 'document_source_unresolved'
  | 'surface_credential_unbound'
  | 'mcp_connection_unbound'
  | 'asset_not_portable'
  | 'skill_config_not_portable'
  | 'directive_binding_unbound'
  | 'contact_delivery_unbound'

export interface AgentBundleUnresolvedReference {
  kind: AgentBundleUnresolvedKind
  element: string
  detail: string
}

export interface AgentBundleImportResponse {
  agentId: string
  unresolved: AgentBundleUnresolvedReference[]
}

export interface AgentBundle {
  bundleVersion: number
  portability?: Record<string, string>
  agent: {
    schemaVersion: number
    name: string
    internalName?: string | null
    authoredDirectives?: unknown[]
    [key: string]: unknown
  }
  routines: Array<{ name: string; version: number; definition: unknown }>
  contextVariables: Array<{ variableName: string; [key: string]: unknown }>
  agentSkills: Array<{ name: string; capability: string; [key: string]: unknown }>
}

export interface AgentBundleSummary {
  agentName: string
  bundleVersion: number
  directiveCount: number
  routineCount: number
  skillCount: number
  contextVariableCount: number
}

export type AgentBundleReadResult =
  | { ok: true; bundle: AgentBundle; summary: AgentBundleSummary }
  | { ok: false; reason: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const countArray = (value: unknown): number => (Array.isArray(value) ? value.length : 0)

/**
 * Structural check only. Whether the bundle's *contents* are importable is the
 * backend's call, and duplicating its rules here would give the operator two
 * verdicts that can disagree. This rejects the file that is not a bundle at all,
 * so the dialog never posts a random JSON file and reports a server error as if
 * it were the file's fault.
 */
export const readAgentBundle = (text: string): AgentBundleReadResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'That file is not valid JSON.' }
  }

  if (!isRecord(parsed) || typeof parsed.bundleVersion !== 'number' || !isRecord(parsed.agent)) {
    return { ok: false, reason: 'That file is not an agent bundle.' }
  }

  if (parsed.bundleVersion !== AGENT_BUNDLE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `This bundle is version ${parsed.bundleVersion}. This workspace reads version ${AGENT_BUNDLE_SCHEMA_VERSION}.`,
    }
  }

  const agent = parsed.agent
  const agentName = typeof agent.name === 'string' && agent.name.trim() ? agent.name : 'Unnamed agent'

  return {
    ok: true,
    bundle: parsed as unknown as AgentBundle,
    summary: {
      agentName,
      bundleVersion: parsed.bundleVersion,
      directiveCount: countArray(agent.authoredDirectives),
      routineCount: countArray(parsed.routines),
      skillCount: countArray(parsed.agentSkills),
      contextVariableCount: countArray(parsed.contextVariables),
    },
  }
}

/**
 * A filename an operator can find again a month later: the agent, then the day.
 * Non-filename characters collapse to a single dash so a name with a slash or a
 * colon cannot produce a path segment or a hidden file.
 */
export const agentBundleFileName = (agentName: string, now: Date): string => {
  const slug = agentName
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60)
  const day = now.toISOString().slice(0, 10)
  return `${slug || 'agent'}-${day}.json`
}

/**
 * Grouped for display: one card per skill or variable that needs attention beats
 * a flat list where the same skill appears three times for three reasons.
 */
export const groupUnresolvedByElement = (
  unresolved: readonly AgentBundleUnresolvedReference[],
): Array<{ element: string; entries: AgentBundleUnresolvedReference[] }> => {
  const groups = new Map<string, AgentBundleUnresolvedReference[]>()
  for (const entry of unresolved) {
    const existing = groups.get(entry.element)
    if (existing) {
      existing.push(entry)
    } else {
      groups.set(entry.element, [entry])
    }
  }
  return [...groups.entries()].map(([element, entries]) => ({ element, entries }))
}

/** The noun an operator recognises, from the `element` the backend labelled. */
export const unresolvedElementLabel = (element: string): string => {
  const separator = element.indexOf(':')
  return separator === -1 ? element : element.slice(separator + 1)
}
