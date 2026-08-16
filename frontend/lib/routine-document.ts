import { instructionToBlockSegments } from '@radioso/routine-markdown'

import { formatConditionLabel, formatSlotFilledLabel, type RoutineBlockBranch, type RoutineBlockEnding, type RoutineBlockGuard, type RoutineBlockInstructionSegment, type RoutineInputBinding } from '@/lib/routine-prose'

const TARGET_MESSAGE_LIMIT = 40

// A default edge into the very next step says only what the numbering already says, so the
// document does not render it. A default edge to an ending, a jump to a step further along,
// and every conditional edge all carry information and still render.
export function branchIsImplicitFallThrough(branch: Pick<RoutineBlockBranch, 'guard' | 'target'>, nextStepId: string | null): boolean {
  return branch.guard.kind === 'default'
    && branch.target.kind === 'step'
    && nextStepId !== null
    && branch.target.stableStepId === nextStepId
}

export function documentTextToSegments(text: string): RoutineBlockInstructionSegment[] {
  return instructionToBlockSegments(text)
}

export function formatBranchTargetLabel(ending: Pick<RoutineBlockEnding, 'kind' | 'instruction' | 'stableStepId'>): string {
  const kind = ending.kind === 'complete' ? 'Finish' : 'Hand off'
  const message = ending.instruction || ending.stableStepId
  const truncatedMessage = message.length > TARGET_MESSAGE_LIMIT ? `${message.slice(0, TARGET_MESSAGE_LIMIT - 1)}…` : message
  return `${kind}: ${truncatedMessage}`
}

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
