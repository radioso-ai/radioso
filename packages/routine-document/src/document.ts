import type {
  RoutineFieldGuardOp,
  RoutineFieldGuardUnit,
  RoutineInputBinding,
  RoutineSlotType,
} from './types.js'

export const ROUTINE_SLOT_TYPES: RoutineSlotType[] = ['text', 'number', 'boolean', 'email', 'date']
export const ROUTINE_FIELD_GUARD_UNITS: RoutineFieldGuardUnit[] = ['days', 'weeks', 'months', 'years']

export type RoutineFieldGuardValue = string | number | boolean
export type RoutineStepMode = 'typed' | 'untyped'
export type RoutineSkillBindingState = {
  inputBindings?: Record<string, RoutineInputBinding>
  outputAssignments?: Record<string, string>
  mode?: RoutineStepMode
} & Record<string, unknown>

const OP_LABELS: Record<RoutineFieldGuardOp, string> = {
  is_true: 'is true',
  is_false: 'is false',
  equals: 'is',
  not_equals: 'is not',
  in: 'is one of',
  is_present: 'is present',
  is_absent: 'is absent',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  older_than: 'is older than',
  within: 'is within the last',
}

// Operators offered per variable type. Numeric comparisons for numbers; relative-date
// comparisons for dates; equality/membership for text. (Type gates what's even valid.)
export function fieldGuardOpsForType(type: RoutineSlotType): RoutineFieldGuardOp[] {
  if (type === 'boolean') return ['is_true', 'is_false', 'is_present', 'is_absent']
  if (type === 'number') return ['gt', 'gte', 'lt', 'lte', 'equals', 'not_equals', 'is_present', 'is_absent']
  if (type === 'date') return ['older_than', 'within', 'is_present', 'is_absent']
  return ['equals', 'not_equals', 'in', 'is_present', 'is_absent']
}

export function fieldGuardOpNeedsValue(op: RoutineFieldGuardOp): boolean {
  return op !== 'is_true' && op !== 'is_false' && op !== 'is_present' && op !== 'is_absent'
}

export function fieldGuardOpNeedsUnit(op: RoutineFieldGuardOp): boolean {
  return op === 'older_than' || op === 'within'
}

export function fieldGuardOpLabel(op: RoutineFieldGuardOp): string {
  return OP_LABELS[op]
}

// Readable rendering of a comparison, used on the condition chip and in the builder.
export function formatConditionLabel(
  varName: string,
  op: RoutineFieldGuardOp,
  value: RoutineFieldGuardValue | null,
  values: RoutineFieldGuardValue[] | null,
  unit: RoutineFieldGuardUnit | null = null,
): string {
  const base = `${varName} ${OP_LABELS[op]}`
  if (op === 'older_than' || op === 'within') return `${base} ${value ?? ''} ${unit ?? ''}`.replace(/\s+/g, ' ').trim()
  if (op === 'in') return `${base} ${(values ?? []).join(', ')}`.trim()
  if (fieldGuardOpNeedsValue(op)) return `${base} ${value ?? ''}`.trim()
  return base
}
// must start with a letter or underscore). The author types a name; the system keys it.
export function slugifyVariableKey(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  const safe = base || 'value'
  return /^[a-z_]/.test(safe) ? safe : `_${safe}`
}

export const SLOT_REFERENCE = /\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

// A variable carried on the chip document. `required`/`mutable` are omitted in the common
// case (required, non-mutable) so the bare `{ id, name, type }` shape round-trips unchanged;
// they're only present when the author marks a slot optional or editable-after-completion.
export type ChipDocVariable = {
  id: string
  name: string
  type: RoutineSlotType
  required?: boolean
  mutable?: boolean
}

// One block of the chip document = one line/paragraph: its readable text plus the chips
// it contains. A block carrying a target chip (handoff) is a branch; otherwise it's a
// step. (Branch-vs-step is keyed on chip presence, never on the English words.) A branch
// carrying a condition chip is decided in code; otherwise the prose is an AI-decided guard.
// One option of an approval gate, as carried on an `approval` chip: its id/label/optional
// description plus the step or terminal the routine branches to when a human picks it.
export type ApprovalDocOption = {
  id: string
  label: string
  description?: string | null
  // Where the routine continues when a person picks this choice. Carried on the block-chip
  // model; absent in the inline model, where the target lives on a separate branch line.
  target?: string
}

export type RoutineDocChip = {
  kind: string
  refId: string
  op?: RoutineFieldGuardOp | null
  value?: RoutineFieldGuardValue | null
  values?: RoutineFieldGuardValue[] | null
  unit?: RoutineFieldGuardUnit | null
  // For a `step` (jump) chip that loops back to an earlier step: the max iterations.
  // A bounded back-edge compiles to a counter guard; the backend validator requires it.
  counterLimit?: number | null
  inputBindings?: Record<string, RoutineInputBinding>
  outputAssignments?: Record<string, string>
  mode?: RoutineStepMode
  // For an `approval` chip: the slot the decision is captured under and the options the
  // human chooses between (each routing to its own target).
  captureKey?: string | null
  options?: ApprovalDocOption[]
}
// A block carrying `headingLevel` is an h1 step title (its text names the step and pins a
// stable id); following non-heading blocks are that step's body. Untitled blocks keep the
// original one-line-one-step behavior.
export type RoutineDocBlock = { text: string; chips: RoutineDocChip[]; headingLevel?: 1 }

// A condition chip whose refId is this sentinel is an outcome guard, not a variable
// comparison: it branches on the preceding tool step's result status (carried in the chip's
// `value`), compiling to a `guardKind: 'outcome'` transition. The sentinel can't collide with
// a real variable id — slugifyVariableKey strips leading/trailing underscores, so it never
// produces `__outcome__`.
export const OUTCOME_GUARD_REF = '__outcome__'

// A condition chip whose refId is this sentinel is a slot-filled guard, not a variable
// comparison: it continues only once the named slots are present, compiling to a
// `guardKind: 'slot_filled'` transition. The slot keys ride in the chip's `values`. Like the
// outcome sentinel it can't collide with a real variable id (slugifyVariableKey strips the
// surrounding underscores, so it never produces `__filled__`).
export const SLOT_FILLED_GUARD_REF = '__filled__'

// Readable "when <a> and <b> are provided" label for a slot-filled guard chip.
export function formatSlotFilledLabel(keys: string[], nameByRef: Map<string, string>): string {
  const names = keys.map((key) => nameByRef.get(key) ?? key)
  const list = names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `when ${list} ${names.length > 1 ? 'are' : 'is'} provided`
}
