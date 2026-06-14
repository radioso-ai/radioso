import type { RoutineDefinitionDraft, RoutineFieldGuardOp, RoutineFieldGuardUnit, RoutineSlotType } from './api-types'

export const ROUTINE_SLOT_TYPES: RoutineSlotType[] = ['text', 'number', 'boolean', 'email', 'date']
export const ROUTINE_FIELD_GUARD_UNITS: RoutineFieldGuardUnit[] = ['days', 'weeks', 'months', 'years']

export type RoutineFieldGuardValue = string | number | boolean

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

// Plain-language label for how a branch is decided, surfaced per branch so the author
// sees which forks are reliable calculations vs AI calls. Used once branch authoring
// lands in the chip editor.
export function branchDecisionLabel(guardKind: string): string {
  if (guardKind === 'llm') return 'Decided by AI'
  if (guardKind === 'default') return 'Otherwise'
  return 'Decided in code'
}

// Turn a free-text variable name into a valid slot key (letters, digits, underscore;
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

const SLOT_REFERENCE = /\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

export type ChipDocVariable = { id: string; name: string; type: RoutineSlotType }

// One block of the chip document = one line/paragraph: its readable text plus the chips
// it contains. A block carrying a target chip (handoff) is a branch; otherwise it's a
// step. (Branch-vs-step is keyed on chip presence, never on the English words.) A branch
// carrying a condition chip is decided in code; otherwise the prose is an AI-decided guard.
export type RoutineDocChip = {
  kind: string
  refId: string
  op?: RoutineFieldGuardOp | null
  value?: RoutineFieldGuardValue | null
  values?: RoutineFieldGuardValue[] | null
  unit?: RoutineFieldGuardUnit | null
}
export type RoutineDocBlock = { text: string; chips: RoutineDocChip[] }

const DONE_TERMINAL_ID = 'done'
const HANDOFF_TERMINAL_ID = 'handoff'

// Serialize the chip document into a routine draft. Non-branch blocks become chat steps,
// chained in order and ending on a complete terminal. A block with a handoff chip is a
// conditional branch from the current step to a handoff terminal, with the block's prose
// as the condition (an AI-decided / llm guard). Structured "decided in code" conditions
// and step-jump targets are later increments.
export function draftFromChipDoc(input: {
  name: string
  trigger: string
  blocks: RoutineDocBlock[]
  variables: ChipDocVariable[]
}): RoutineDefinitionDraft {
  // Keep blocks with prose or chips (a branch can be pure chips: a condition + target).
  const blocks = input.blocks.filter((block) => block.text.trim().length > 0 || block.chips.length > 0)

  // Used slots come from any block — step instructions and branch conditions both count.
  const usedSlotIds = new Set<string>()
  for (const block of blocks) {
    for (const match of block.text.matchAll(SLOT_REFERENCE)) {
      usedSlotIds.add(match[1]!)
    }
    // A condition chip branches on a variable — that's a slot reference too.
    for (const chip of block.chips) {
      if (chip.kind === 'condition') usedSlotIds.add(chip.refId)
    }
  }
  const slots = input.variables
    .filter((variable) => usedSlotIds.has(variable.id))
    .map((variable, index) => ({
      stableSlotId: variable.id,
      key: variable.id,
      type: variable.type,
      required: true,
      description: variable.name,
      ordinal: index,
    }))

  const steps: RoutineDefinitionDraft['steps'] = []
  const transitions: RoutineDefinitionDraft['transitions'] = []
  let needHandoffTerminal = false
  let lastStepId: string | null = null
  let ordinal = 0

  for (const block of blocks) {
    if (block.chips.some((chip) => chip.kind === 'handoff')) {
      // A conditional handoff branch from the step we're currently in. A condition chip
      // makes it decided-in-code (field guard); otherwise the prose is an AI-decided guard.
      if (lastStepId) {
        needHandoffTerminal = true
        const condition = block.chips.find((chip) => chip.kind === 'condition')
        if (condition?.op) {
          transitions.push({
            fromStep: lastStepId,
            toRef: HANDOFF_TERMINAL_ID,
            guardKind: 'field',
            guardText: null,
            outcomeStatus: null,
            counterLimit: null,
            fieldRef: condition.refId,
            fieldOp: condition.op,
            fieldValue: condition.value ?? null,
            fieldValues: condition.values ?? null,
            fieldUnit: condition.unit ?? null,
            ordinal: ordinal++,
          })
        } else {
          transitions.push({
            fromStep: lastStepId,
            toRef: HANDOFF_TERMINAL_ID,
            guardKind: 'llm',
            guardText: block.text.trim(),
            outcomeStatus: null,
            counterLimit: null,
            ordinal: ordinal++,
          })
        }
      }
      continue
    }
    const instruction = block.text.trim()
    if (!instruction) {
      // A non-branch block with no prose (e.g. an orphan condition chip) isn't a step.
      continue
    }
    const id = `step_${steps.length + 1}`
    steps.push({
      stableStepId: id,
      kind: 'chat',
      instruction,
      toolRef: null,
      actionType: null,
      ordinal: steps.length,
      metadata: {},
    })
    if (lastStepId) {
      transitions.push({
        fromStep: lastStepId,
        toRef: id,
        guardKind: 'default',
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        ordinal: ordinal++,
      })
    }
    lastStepId = id
  }

  if (lastStepId) {
    transitions.push({
      fromStep: lastStepId,
      toRef: DONE_TERMINAL_ID,
      guardKind: 'default',
      guardText: null,
      outcomeStatus: null,
      counterLimit: null,
      ordinal: ordinal++,
    })
  }

  const terminals: RoutineDefinitionDraft['terminals'] = [
    { stableStepId: DONE_TERMINAL_ID, kind: 'complete', instruction: 'All set.', ordinal: 0 },
  ]
  if (needHandoffTerminal) {
    terminals.push({ stableStepId: HANDOFF_TERMINAL_ID, kind: 'handoff', instruction: 'Bringing in a teammate.', ordinal: 1 })
  }

  return {
    name: input.name.trim() || 'Untitled routine',
    activation: {
      triggerDescription: input.trigger.trim() || 'When this routine applies.',
      gateRef: null,
      priority: 0,
    },
    slots,
    steps,
    transitions,
    terminals,
  }
}
