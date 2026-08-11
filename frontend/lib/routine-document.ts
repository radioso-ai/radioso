import { formatConditionLabel, formatSlotFilledLabel, type RoutineBlockGuard, type RoutineInputBinding } from '@/lib/routine-prose'

export function guardToSentence(guard: Pick<RoutineBlockGuard, 'kind' | 'guardText' | 'outcomeStatus' | 'counterLimit' | 'fieldRef' | 'fieldOp' | 'fieldValue' | 'fieldValues' | 'fieldUnit'> & { slotKeys?: string[] }, slotNames: Map<string, string>): string {
  switch (guard.kind) {
    case 'llm':
      return guard.guardText ?? 'AI decides'
    case 'default':
      return 'otherwise'
    case 'slot_filled':
      return formatSlotFilledLabel(guard.slotKeys ?? [], slotNames)
    case 'outcome':
      return `when the skill reports ${guard.outcomeStatus ?? guard.guardText ?? 'unknown'}`
    case 'counter':
      return `after ${guard.counterLimit ?? 0} repeats`
    case 'field': {
      if (!guard.fieldRef) return 'choose a rule…'
      const fieldRef = guard.fieldRef
      return formatConditionLabel(
        slotNames.get(fieldRef) ?? fieldRef,
        guard.fieldOp ?? 'equals',
        guard.fieldValue ?? null,
        guard.fieldValues ?? null,
        guard.fieldUnit ?? null,
      )
    }
  }
}

const bindingValue = (binding: RoutineInputBinding): string => {
  if (binding.kind === 'literal') return String(binding.value)
  if (binding.kind === 'contextVariableRef') return `context.${binding.contextVariable}`
  return binding.ref
}

export function formatBindingLine(
  inputBindings: Record<string, RoutineInputBinding> | undefined,
  outputAssignments: Record<string, string> | undefined,
): string | null {
  const inputs = Object.entries(inputBindings ?? {}).map(([key, binding]) => `${key} = ${bindingValue(binding)}`)
  const outputs = Object.entries(outputAssignments ?? {}).map(([key, value]) => `${key} = ${value}`)
  if (inputs.length === 0 && outputs.length === 0) return null
  return `uses ${inputs.length > 0 ? inputs.join(', ') : 'nothing'} → sets ${outputs.length > 0 ? outputs.join(', ') : 'nothing'}`
}
