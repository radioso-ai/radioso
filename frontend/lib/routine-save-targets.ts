import { routineSlotSavesToValueType } from '@radioso/routine-definition'

import type { AgentContextVariableEnablement, ContextVariable, RoutineSlot } from '@/lib/api-types'

// An attribute a routine field may save its value to when the routine ends (#1884): one the agent
// keeps a value of, set by the website or API, and that is not proof, since a visitor typed the
// value. `private` is whether it is Private (sensitive).
export type RoutineSaveTarget = { name: string; valueType: ContextVariable['valueType']; private: boolean }

// The source a field saves to. The backend's `readsStoredValue` also keeps a value the AI picks,
// but the AI picks only a Choice, which no field saves to.
const STORED_SOURCES: ReadonlySet<AgentContextVariableEnablement['source']> = new Set(['pushed'])

export function routineSaveTargetsFromEnablements(enablements: readonly AgentContextVariableEnablement[]): RoutineSaveTarget[] {
  return enablements.flatMap((enablement) => {
    const variable = enablement.variable
    if (!enablement.enabled || !variable || !STORED_SOURCES.has(enablement.source) || variable.trustTier === 'signed') return []
    return [{ name: variable.name, valueType: variable.valueType, private: variable.sensitivity === 'sensitive' }]
  })
}

// The targets a field may pick: of a type its value saves to, and Private for a sensitive field.
// Narrows the choice only; the operator still names the attribute, never the field's key or type.
export function saveTargetsForField(
  targets: readonly RoutineSaveTarget[],
  field: Pick<RoutineSlot, 'type' | 'sensitivity'>,
): RoutineSaveTarget[] {
  return targets.filter((target) =>
    routineSlotSavesToValueType(field.type, target.valueType) && (field.sensitivity !== 'sensitive' || target.private))
}
