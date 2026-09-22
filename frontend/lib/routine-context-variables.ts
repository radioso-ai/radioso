import type { AgentContextVariableEnablement } from '@/lib/api-types'

// A context variable a routine step can read with `{{context.<name>}}`: the visitor's current
// page, the request facts Radioso observed, or a host-defined value the agent has enabled.
// The `label` is what the picker and chip show; the `name` is the token, always.
export type RoutineEditorContextVariable = { name: string; label: string }

// The code-owned built-ins every agent has (see the backend context-variables registry).
// `visitor_identity` is left out on purpose: it is sensitive, so a step would only ever read
// the redaction marker from it.
const BUILT_IN_CONTEXT_VARIABLES: readonly RoutineEditorContextVariable[] = [
  { name: 'page_context', label: 'Current page' },
  { name: 'visitor_request', label: 'Visitor request' },
]

export function contextVariableLabel(name: string): string {
  return BUILT_IN_CONTEXT_VARIABLES.find((variable) => variable.name === name)?.label ?? name
}

// Mirrors the backend's available set for validation: built-ins first, then every enabled
// enablement whose variable row came back with it. As on the backend, a host-defined
// variable named after a built-in takes the built-in's place, so the picker lists it once
// under its own name.
export function routineContextVariablesFromEnablements(
  enablements: readonly AgentContextVariableEnablement[],
): RoutineEditorContextVariable[] {
  const byName = new Map(BUILT_IN_CONTEXT_VARIABLES.map((variable) => [variable.name, variable]))
  for (const enablement of enablements) {
    const name = enablement.variable?.name
    if (!enablement.enabled || !name) continue
    byName.set(name, { name, label: name })
  }
  return [...byName.values()]
}
