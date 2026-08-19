import { formatConditionLabel, formatSlotFilledLabel, instructionToBlockSegments, type RoutineBlockBranch, type RoutineBlockEnding, type RoutineBlockGuard, type RoutineBlockInstructionSegment, type RoutineInputBinding } from '@/lib/routine-prose'

import type { RoutineDefinitionDraft, RoutineValidationDiagnostic } from '@/lib/api-types'

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
  // A fresh ending has no message yet; its stable id would only leak an internal name.
  if (!ending.instruction) return `${kind} (no message yet)`
  const message = ending.instruction
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

// The editing schema accepts empty strings for content still being written (an unnamed
// ending message, an untyped AI condition), but the persistence schema requires present
// text to be non-empty. Saving therefore translates "still empty" back to "absent" so a
// half-finished row never turns into a rejected request.
const emptyToNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function sanitizeDraftContentForSave(draft: RoutineDefinitionDraft): RoutineDefinitionDraft {
  return {
    ...draft,
    slots: draft.slots.map((slot) => ({ ...slot, description: emptyToNull(slot.description) })),
    steps: draft.steps.map((step) => ({
      ...step,
      toolRef: emptyToNull(step.toolRef),
      actionType: emptyToNull(step.actionType),
      captureKey: emptyToNull(step.captureKey),
      ...(step.options ? { options: step.options.map((option) => ({ ...option, description: emptyToNull(option.description) })) } : {}),
    })),
    transitions: draft.transitions.map((transition) => ({
      ...transition,
      guardText: emptyToNull(transition.guardText),
      outcomeStatus: emptyToNull(transition.outcomeStatus),
      fieldValue: typeof transition.fieldValue === 'string' ? emptyToNull(transition.fieldValue) : transition.fieldValue ?? null,
      fieldValues: transition.fieldValues && transition.fieldValues.length > 0 ? transition.fieldValues : null,
    })),
    terminals: draft.terminals.map((terminal) => ({ ...terminal, instruction: emptyToNull(terminal.instruction) })),
  }
}

// Validator diagnostics arrive phrased for the graph ("structured guard missing
// parameter: field guard from \"step_3\"…"). Anchored to its row, a diagnostic no longer
// needs to name its location, so the typed code maps to a plain sentence; codes without a
// mapping fall back to the validator's own message rather than hiding.
const DOCUMENT_DIAGNOSTIC_COPY: Partial<Record<RoutineValidationDiagnostic['code'], string>> = {
  structured_guard_missing_parameter: 'This rule needs a variable and a comparison.',
  field_guard_unknown_reference: 'This rule points at information the routine does not collect.',
  field_guard_incompatible_type: "This rule's comparison does not fit the variable's type.",
  unreachable_step: 'Nothing leads to this step.',
  dangling_step_reference: 'This points at a step that no longer exists.',
  unbounded_back_edge: 'This jump back needs a repeat limit.',
  declared_unused_slot: 'This information is collected but never used.',
  referenced_undeclared_slot: 'This step uses information the routine does not collect.',
  unknown_skill: 'This skill is not available to the agent.',
  outcome_guard_on_non_tool_step: 'An outcome rule only works after a skill step.',
}

export function documentDiagnosticText(diagnostic: RoutineValidationDiagnostic): string {
  return DOCUMENT_DIAGNOSTIC_COPY[diagnostic.code] ?? diagnostic.message
}
