import type { RoutineTransition } from './api-types'

// An approval gate is one `approval` step (instruction + captureKey + options[]) plus one
// deterministic field-guard transition per option. The backend validator requires those
// edges to be exactly `<captureKey>.id == <optionId>` field guards, so both routine editors
// (Form and Prose) build them through this single helper rather than hand-rolling the shape.

export const APPROVAL_OPTION_LIMIT = 8

// The field reference an approval option branches on: the chosen option's id, captured under
// the step's captureKey. (The decision the human makes is recorded as `{captureKey}.id`.)
export const approvalCaptureFieldRef = (captureKey: string): string => `${captureKey}.id`

export type ApprovalOptionBranch = { optionId: string; target: string }

// One field-guard transition per option: `<captureKey>.id == <optionId>` → the option's
// target step/terminal. `nextOrdinal` lets the caller weave these into its own running
// transition ordinal sequence.
export function approvalOptionTransitions(
  fromStep: string,
  captureKey: string,
  branches: ApprovalOptionBranch[],
  nextOrdinal: () => number,
): RoutineTransition[] {
  const fieldRef = approvalCaptureFieldRef(captureKey)
  return branches.map((branch): RoutineTransition => ({
    fromStep,
    toRef: branch.target,
    guardKind: 'field',
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    fieldRef,
    fieldOp: 'equals',
    fieldValue: branch.optionId,
    fieldValues: null,
    fieldUnit: null,
    ordinal: nextOrdinal(),
  }))
}

// Inverse of approvalOptionTransitions: recover each option's branch target from an approval
// step's outgoing field guards, keyed on the option id carried in `fieldValue`. Used when
// loading an approval routine back into either editor.
export function approvalOptionTargets(transitions: RoutineTransition[]): Map<string, string> {
  const targets = new Map<string, string>()
  for (const transition of transitions) {
    if (transition.guardKind !== 'field' || transition.fieldOp !== 'equals') continue
    if (typeof transition.fieldValue !== 'string') continue
    targets.set(transition.fieldValue, transition.toRef)
  }
  return targets
}
