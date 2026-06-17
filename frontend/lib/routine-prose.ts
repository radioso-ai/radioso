import type { RoutineDefinitionDraft, RoutineFieldGuardOp, RoutineFieldGuardUnit, RoutineSlotType, RoutineTransition } from './api-types'

export const ROUTINE_SLOT_TYPES: RoutineSlotType[] = ['text', 'number', 'boolean', 'email', 'date']
export const ROUTINE_FIELD_GUARD_UNITS: RoutineFieldGuardUnit[] = ['days', 'weeks', 'months', 'years']

export type RoutineFieldGuardValue = string | number | boolean
export type RoutineInputBinding =
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'variableRef'; ref: string }
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
  // For a `step` (jump) chip that loops back to an earlier step: the max iterations.
  // A bounded back-edge compiles to a counter guard; the backend validator requires it.
  counterLimit?: number | null
  inputBindings?: Record<string, RoutineInputBinding>
  outputAssignments?: Record<string, string>
  mode?: RoutineStepMode
}
// A block carrying `headingLevel` is an h1 step title (its text names the step and pins a
// stable id); following non-heading blocks are that step's body. Untitled blocks keep the
// original one-line-one-step behavior.
export type RoutineDocBlock = { text: string; chips: RoutineDocChip[]; headingLevel?: 1 }

const DONE_TERMINAL_ID = 'done'
const HANDOFF_TERMINAL_ID = 'handoff'
// The terminal copy the prose editor regenerates. The prose surface has no field for
// terminal messages, so draftFromChipDoc emits these defaults and routineToChipDoc
// refuses (falls back to Form) any routine whose terminals differ — otherwise an
// author's custom completion/handoff message would be silently overwritten on load+save.
const LEGACY_COMPLETE_INSTRUCTION = 'All set.'
const DEFAULT_HANDOFF_INSTRUCTION = 'Bringing in a teammate.'

export const createEmptyRoutineProseDraft = (input: {
  name?: string
  triggerDescription?: string
  priority?: number
} = {}): RoutineDefinitionDraft => ({
  name: input.name ?? '',
  activation: {
    triggerDescription: input.triggerDescription ?? '',
    gateRef: null,
    priority: input.priority ?? 0,
  },
  slots: [],
  steps: [],
  transitions: [],
  terminals: [{
    stableStepId: DONE_TERMINAL_ID,
    kind: 'complete',
    instruction: null,
    ordinal: 0,
  }],
})

// Serialize the chip document into a routine draft. An h1 heading block names a step
// (its title pins a stable id + author label; following prose is the step's body); an
// untitled block is a one-line step (the original behavior). A block with a target chip
// is a conditional branch from the current step: a handoff/end chip targets a terminal,
// a `step` chip jumps to a named step (forward, or backward as a counter-bounded loop).
// A condition chip makes the guard decided-in-code (field); otherwise the prose is an
// AI-decided (llm) guard.
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
      if (chip.kind === 'skill') {
        for (const binding of Object.values(chip.inputBindings ?? {})) {
          if (binding.kind === 'variableRef') usedSlotIds.add(binding.ref)
        }
      }
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
  // The titled step (started by an h1 heading) currently accreting body prose. Untitled
  // authoring leaves this null and keeps the original one-line-one-step behavior.
  let titledStep: { step: RoutineDefinitionDraft['steps'][number]; body: string[] } | null = null
  const flushTitledBody = () => {
    if (!titledStep) return
    const body = titledStep.body.join('\n').trim()
    // Body prose is the instruction; the title is the fallback so every step is non-empty.
    if (body) titledStep.step.instruction = body
  }

  // Emit a guarded edge from the current step. A condition chip → field guard; a `step`
  // chip carrying a counter limit → a bounded loop (counter guard); otherwise the prose
  // is an AI-decided (llm) guard.
  const branchFrom = (fromStep: string, toRef: string, block: RoutineDocBlock) => {
    const condition = block.chips.find((chip) => chip.kind === 'condition')
    const stepChip = block.chips.find((chip) => chip.kind === 'step')
    if (condition?.op) {
      transitions.push({
        fromStep,
        toRef,
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
    } else if (stepChip && stepChip.counterLimit != null) {
      transitions.push({
        fromStep,
        toRef,
        guardKind: 'counter',
        guardText: null,
        outcomeStatus: null,
        counterLimit: stepChip.counterLimit,
        ordinal: ordinal++,
      })
    } else {
      transitions.push({
        fromStep,
        toRef,
        guardKind: 'llm',
        guardText: block.text.trim(),
        outcomeStatus: null,
        counterLimit: null,
        ordinal: ordinal++,
      })
    }
  }

  for (const block of blocks) {
    const handoffChip = block.chips.find((chip) => chip.kind === 'handoff')
    const endChip = block.chips.find((chip) => chip.kind === 'end')
    const stepChip = block.chips.find((chip) => chip.kind === 'step')
    if (handoffChip || endChip || stepChip) {
      // A branch from the step we're currently in. A `step` chip jumps to a named step;
      // otherwise the target is a terminal (handoff escalates, end completes).
      if (lastStepId) {
        if (stepChip) {
          branchFrom(lastStepId, stepChip.refId, block)
        } else {
          if (handoffChip) needHandoffTerminal = true
          branchFrom(lastStepId, handoffChip ? HANDOFF_TERMINAL_ID : DONE_TERMINAL_ID, block)
        }
      }
      continue
    }
    if (block.headingLevel === 1 && block.text.trim()) {
      // An h1 heading names a step: the title is the stable id + author label; following
      // body prose becomes the instruction (the title is the fallback when there's none).
      flushTitledBody()
      const title = block.text.trim()
      const id = slugifyVariableKey(title)
      const step = {
        stableStepId: id,
        kind: 'chat' as const,
        instruction: title,
        toolRef: null,
        actionType: null,
        ordinal: steps.length,
        metadata: { outlineLabel: title },
      }
      steps.push(step)
      if (lastStepId) {
        transitions.push({ fromStep: lastStepId, toRef: id, guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, ordinal: ordinal++ })
      }
      lastStepId = id
      titledStep = { step, body: [] }
      continue
    }
    // A skill chip turns the step into a tool step the runner dispatches through the
    // skill port (the skill itself is defined elsewhere; here it's referenced by name).
    const skillChip = block.chips.find((chip) => chip.kind === 'skill')
    const instruction = block.text.trim()
    if (!instruction && !skillChip) {
      // A non-branch block with no prose (e.g. an orphan condition chip) isn't a step.
      continue
    }
    if (titledStep) {
      // Body of the current titled step (a skill chip makes it a tool step).
      if (instruction) titledStep.body.push(instruction)
      if (skillChip) {
        titledStep.step.kind = 'tool'
        titledStep.step.toolRef = skillChip.refId
        titledStep.step.metadata = {
          ...(titledStep.step.metadata ?? {}),
          inputBindings: skillChip.inputBindings ?? {},
          outputAssignments: skillChip.outputAssignments ?? {},
          mode: skillChip.mode ?? 'typed',
        }
      }
      flushTitledBody()
      continue
    }
    const id = `step_${steps.length + 1}`
    steps.push({
      stableStepId: id,
      kind: skillChip ? 'tool' : 'chat',
      // Every step needs a non-empty instruction (backend requirement). A skill chip
      // alone on a line carries no prose, so fall back to the skill name.
      instruction: !instruction && skillChip ? skillChip.refId : instruction,
      toolRef: skillChip ? skillChip.refId : null,
      actionType: null,
      ordinal: steps.length,
      metadata: skillChip
        ? {
            inputBindings: skillChip.inputBindings ?? {},
            outputAssignments: skillChip.outputAssignments ?? {},
            mode: skillChip.mode ?? 'typed',
          }
        : {},
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

  flushTitledBody()
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
    { stableStepId: DONE_TERMINAL_ID, kind: 'complete', instruction: null, ordinal: 0 },
  ]
  if (needHandoffTerminal) {
    terminals.push({ stableStepId: HANDOFF_TERMINAL_ID, kind: 'handoff', instruction: DEFAULT_HANDOFF_INSTRUCTION, ordinal: 1 })
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

// One inline piece of a loaded prose paragraph: literal text or a chip. This is the
// richer shape draftFromChipDoc's flat {text, chips} can't carry — it preserves where
// each chip sits inline — so the editor can rebuild the Lexical document on load.
export type ProseChipKind = 'variable' | 'skill' | 'handoff' | 'step' | 'condition' | 'end'
export type ProseSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'chip'
      chipKind: ProseChipKind
      refId: string
      label: string
      op?: RoutineFieldGuardOp
      value?: RoutineFieldGuardValue | null
      values?: RoutineFieldGuardValue[] | null
      unit?: RoutineFieldGuardUnit | null
      // For a `step` (jump) chip that loops back: the max iterations (counter bound).
      counterLimit?: number | null
      inputBindings?: Record<string, RoutineInputBinding>
      outputAssignments?: Record<string, string>
      mode?: RoutineStepMode
    }
// A paragraph is a step title (headingLevel 1) or ordinary prose/branch content. The
// title pins the step's stable id + label; the following non-heading paragraphs are its
// body. Headings let an author name a step so a jump can target it.
export type ProseParagraph = { headingLevel?: 1; segments: ProseSegment[] }
export type ProseDoc = { variables: ChipDocVariable[]; paragraphs: ProseParagraph[] }

const HANDOFF_CHIP_LABEL = 'handoff'

function parseInstructionSegments(instruction: string, nameByRef: Map<string, string>): ProseSegment[] {
  const segments: ProseSegment[] = []
  let lastIndex = 0
  for (const match of instruction.matchAll(SLOT_REFERENCE)) {
    const index = match.index ?? 0
    if (index > lastIndex) segments.push({ kind: 'text', text: instruction.slice(lastIndex, index) })
    const refId = match[1]!
    segments.push({ kind: 'chip', chipKind: 'variable', refId, label: `@${nameByRef.get(refId) ?? refId}` })
    lastIndex = index + match[0].length
  }
  if (lastIndex < instruction.length) segments.push({ kind: 'text', text: instruction.slice(lastIndex) })
  return segments.length > 0 ? segments : [{ kind: 'text', text: instruction }]
}

// The guard prefix of a branch paragraph: a condition chip (decided-in-code), or the
// AI-decided prose. A counter-bounded loop has no prose prefix — the bound rides on the
// trailing step chip — so it returns nothing here.
function branchGuardSegments(edge: RoutineTransition, nameByRef: Map<string, string>): ProseSegment[] {
  if (edge.guardKind === 'field' && edge.fieldRef && edge.fieldOp) {
    const name = nameByRef.get(edge.fieldRef) ?? edge.fieldRef
    return [{
      kind: 'chip',
      chipKind: 'condition',
      refId: edge.fieldRef,
      label: formatConditionLabel(name, edge.fieldOp, edge.fieldValue ?? null, edge.fieldValues ?? null, edge.fieldUnit ?? null),
      op: edge.fieldOp,
      value: edge.fieldValue ?? null,
      values: edge.fieldValues ?? null,
      unit: edge.fieldUnit ?? null,
    }]
  }
  if (edge.guardKind === 'llm' && edge.guardText) {
    return [{ kind: 'text', text: edge.guardText }]
  }
  return []
}

// A branch paragraph = the guard prefix followed by the target chip (handoff/end terminal
// or a `step` jump chip).
function branchParagraph(edge: RoutineTransition, nameByRef: Map<string, string>, trailing: ProseSegment): ProseParagraph {
  return { segments: [...branchGuardSegments(edge, nameByRef), trailing] }
}

// Inverse of draftFromChipDoc: rebuild the chip document (variables + paragraphs with
// inline chips) from a routine, so an existing routine can be edited in the prose editor.
// Chat steps and skill-bound tool steps are representable; it returns null for shapes the
// prose editor can't show — action (outbox) steps, counter/outcome/slot guards, multi-way
// forks, a non-handoff branch target, an activation gate, or completion export — so the
// caller falls back to the form editor rather than silently dropping that configuration.
export function routineToChipDoc(routine: RoutineDefinitionDraft): ProseDoc | null {
  if (routine.activation.gateRef) return null
  if (routine.completionExport?.enabled) return null

  const steps = [...routine.steps].sort((left, right) => left.ordinal - right.ordinal)
  if (steps.some((step) => step.kind !== 'chat' && step.kind !== 'tool')) return null
  if (steps.some((step) => step.kind === 'tool' && !step.toolRef)) return null

  const completeTerminals = routine.terminals.filter((terminal) => terminal.kind === 'complete')
  const handoffTerminals = routine.terminals.filter((terminal) => terminal.kind === 'handoff')
  if (completeTerminals.length !== 1) return null
  if (handoffTerminals.length > 1) return null
  if (routine.terminals.length !== completeTerminals.length + handoffTerminals.length) return null

  // The prose editor regenerates terminals from constants and can't show their copy or
  // ids — so any routine with a custom completion/handoff message or a non-default
  // terminal id must edit in Form, or that copy/id would be lost on a load+save.
  const complete = completeTerminals[0]!
  if (
    complete.stableStepId !== DONE_TERMINAL_ID ||
    (complete.instruction !== null && complete.instruction !== LEGACY_COMPLETE_INSTRUCTION)
  ) return null
  const handoff = handoffTerminals[0]
  if (handoff && (handoff.stableStepId !== HANDOFF_TERMINAL_ID || (handoff.instruction ?? '') !== DEFAULT_HANDOFF_INSTRUCTION)) return null

  // The prose editor treats every collected variable as required (it regenerates
  // required:true). A non-required slot would be silently flipped on save, so fall back.
  if (routine.slots.some((slot) => slot.required === false)) return null

  const completeId = complete.stableStepId
  const handoffId = handoff?.stableStepId ?? null
  const stepIds = new Set(steps.map((step) => step.stableStepId))
  if (routine.transitions.some((transition) => !stepIds.has(transition.fromStep))) return null

  const variables: ChipDocVariable[] = [...routine.slots]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((slot) => ({ id: slot.key, name: (slot.description ?? '').trim() || slot.key, type: slot.type }))
  const nameByRef = new Map(variables.map((variable) => [variable.id, variable.name]))

  const outgoing = new Map<string, RoutineTransition[]>()
  for (const transition of routine.transitions) {
    const list = outgoing.get(transition.fromStep) ?? []
    list.push(transition)
    outgoing.set(transition.fromStep, list)
  }

  const titleOf = (step: RoutineDefinitionDraft['steps'][number]): string | null => {
    const label = (step.metadata as Record<string, unknown> | undefined)?.outlineLabel
    return typeof label === 'string' && label.trim() ? label.trim() : null
  }
  const titleByStepId = new Map(steps.map((step) => [step.stableStepId, titleOf(step)] as const))

  const paragraphs: ProseParagraph[] = []
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!
    const title = titleOf(step)
    if (title) {
      // A titled step: an h1 heading (its stable name) plus an optional body paragraph —
      // the instruction when it isn't just the title echoed back. A tool step's skill chip
      // rides on the body.
      paragraphs.push({ headingLevel: 1, segments: [{ kind: 'text', text: title }] })
      const bodyText = (step.instruction ?? '') !== title ? (step.instruction ?? '') : ''
      const bodySegments = bodyText ? parseInstructionSegments(bodyText, nameByRef) : []
      if (step.kind === 'tool' && step.toolRef) {
        const metadata = step.metadata as RoutineSkillBindingState | undefined
        bodySegments.push({
          kind: 'chip',
          chipKind: 'skill',
          refId: step.toolRef,
          label: `@${step.toolRef}`,
          inputBindings: metadata?.inputBindings,
          outputAssignments: metadata?.outputAssignments,
          mode: metadata?.mode,
        })
      }
      if (bodySegments.length > 0) paragraphs.push({ segments: bodySegments })
    } else {
      const segments = parseInstructionSegments(step.instruction ?? '', nameByRef)
      if (step.kind === 'tool' && step.toolRef) {
        const metadata = step.metadata as RoutineSkillBindingState | undefined
        segments.push({
          kind: 'chip',
          chipKind: 'skill',
          refId: step.toolRef,
          label: `@${step.toolRef}`,
          inputBindings: metadata?.inputBindings,
          outputAssignments: metadata?.outputAssignments,
          mode: metadata?.mode,
        })
      }
      paragraphs.push({ segments })
    }

    // A step continues via exactly one default edge (to the next step, or the complete
    // terminal for the last step). Non-default edges are branches: llm/field to a terminal
    // (handoff/end), or llm/field/counter to another step (a jump — a counter bound makes it
    // a safe backward loop). A jump can only target a titled step (it needs a stable name).
    // Anything else isn't prose-shaped.
    const chainTarget = steps[index + 1]?.stableStepId ?? completeId
    let sawChain = false
    for (const edge of [...(outgoing.get(step.stableStepId) ?? [])].sort((left, right) => left.ordinal - right.ordinal)) {
      if (edge.guardKind === 'default') {
        if (sawChain || edge.toRef !== chainTarget) return null
        sawChain = true
      } else if (handoffId && edge.toRef === handoffId && (edge.guardKind === 'llm' || edge.guardKind === 'field')) {
        paragraphs.push(branchParagraph(edge, nameByRef, { kind: 'chip', chipKind: 'handoff', refId: HANDOFF_TERMINAL_ID, label: HANDOFF_CHIP_LABEL }))
      } else if (edge.toRef === completeId && (edge.guardKind === 'llm' || edge.guardKind === 'field')) {
        paragraphs.push(branchParagraph(edge, nameByRef, { kind: 'chip', chipKind: 'end', refId: DONE_TERMINAL_ID, label: 'end' }))
      } else if (stepIds.has(edge.toRef) && (edge.guardKind === 'llm' || edge.guardKind === 'field' || edge.guardKind === 'counter')) {
        const targetTitle = titleByStepId.get(edge.toRef)
        if (!targetTitle) return null
        paragraphs.push(branchParagraph(edge, nameByRef, {
          kind: 'chip',
          chipKind: 'step',
          refId: edge.toRef,
          label: targetTitle,
          counterLimit: edge.guardKind === 'counter' ? (edge.counterLimit ?? null) : null,
        }))
      } else {
        return null
      }
    }
    if (!sawChain) return null
  }

  return { variables, paragraphs }
}
