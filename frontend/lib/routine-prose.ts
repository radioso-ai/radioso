import type { RoutineCompletionExport, RoutineDefinitionDraft, RoutineFieldGuardOp, RoutineFieldGuardUnit, RoutineReentryMode, RoutineSlotType, RoutineTransition } from './api-types'
import { approvalOptionTransitions } from './routine-approval'

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

// Canonical terminal references the chip document always uses. The actual terminal id and
// message live in a ProseTerminalConfig carried alongside the document (so a routine keeps
// a custom id or completion/handoff copy across a prose round-trip); the serializers map
// between these canonical refs and the configured ids.
const DONE_TERMINAL_ID = 'done'
const HANDOFF_TERMINAL_ID = 'handoff'
// The default message a handoff terminal carries when the author hasn't set one.
const DEFAULT_HANDOFF_INSTRUCTION = 'Bringing in a teammate.'

// Step metadata keys the chip document preserves. The skill-binding state only round-trips on
// a tool step (it rides on the skill chip); the outline label (a titled step's heading) can
// ride on any step. Any other key — or binding state on a non-tool step — is authored metadata
// the prose round-trip can't carry, so routineToChipDoc falls back to Form when it sees one.
const PRESERVED_TOOL_METADATA_KEYS = new Set(['inputBindings', 'outputAssignments', 'mode', 'outlineLabel'])
const OUTLINE_LABEL_ONLY = new Set(['outlineLabel'])

// True when a step's metadata round-trips through the chip document without loss or renaming.
function stepMetadataIsRepresentable(step: RoutineDefinitionDraft['steps'][number]): boolean {
  const metadata = (step.metadata ?? {}) as Record<string, unknown>
  const allowed = step.kind === 'tool' ? PRESERVED_TOOL_METADATA_KEYS : OUTLINE_LABEL_ONLY
  if (Object.keys(metadata).some((key) => !allowed.has(key))) return false
  // An outline label round-trips only as a heading whose text draftFromChipDoc slugifies back
  // into the step id. So whenever the key is present it must be a non-empty string that
  // slugifies to the existing id; an empty or non-string label would be silently dropped (it
  // is authored metadata the compiler keeps), and a mismatching one would rename the step.
  if ('outlineLabel' in metadata) {
    const label = metadata.outlineLabel
    if (typeof label !== 'string' || !label.trim() || slugifyVariableKey(label.trim()) !== step.stableStepId) return false
  }
  return true
}

// A condition chip whose refId is this sentinel is an outcome guard, not a variable
// comparison: it branches on the preceding tool step's result status (carried in the chip's
// `value`), compiling to a `guardKind: 'outcome'` transition. The sentinel can't collide with
// a real variable id — slugifyVariableKey strips leading/trailing underscores, so it never
// produces `__outcome__`.
export const OUTCOME_GUARD_REF = '__outcome__'

// True when a condition chip is an outcome guard (refId sentinel + a status in `value`).
function isOutcomeConditionChip(chip: { refId: string; value?: RoutineFieldGuardValue | null }): boolean {
  return chip.refId === OUTCOME_GUARD_REF && typeof chip.value === 'string' && chip.value.trim().length > 0
}

// The terminal id + message the prose editor preserves outside the chip body (the body only
// references the canonical `done`/`handoff`). Fields are optional: an omitted id defaults to
// the canonical terminal id, and an omitted completion message defaults to null / the handoff
// message to the default copy.
export type ProseTerminal = { id?: string; instruction?: string | null }
export type ProseTerminalConfig = { complete?: ProseTerminal | null; handoff?: ProseTerminal | null }

// Read the complete/handoff terminal config off a routine so the prose host can edit the
// messages and re-emit the same ids. Only meaningful for prose-representable routines (one
// complete terminal, at most one handoff); other shapes fall back to Form before this runs.
export function readProseTerminals(routine: RoutineDefinitionDraft): { complete: ProseTerminal; handoff: ProseTerminal | null } {
  const complete = routine.terminals.find((terminal) => terminal.kind === 'complete')
  const handoff = routine.terminals.find((terminal) => terminal.kind === 'handoff')
  return {
    complete: {
      id: complete?.stableStepId ?? DONE_TERMINAL_ID,
      instruction: complete?.instruction ?? null,
    },
    handoff: handoff ? { id: handoff.stableStepId, instruction: handoff.instruction ?? null } : null,
  }
}

// Read the completion-export config off a routine so the prose host can edit it and re-emit
// it. Returns null when export is absent or disabled — the prose body does not encode it, so
// the host carries it alongside (like the terminal messages and priority/reentry).
export function readProseCompletionExport(routine: RoutineDefinitionDraft): RoutineCompletionExport | null {
  return routine.completionExport?.enabled ? routine.completionExport : null
}

export const createEmptyRoutineProseDraft = (input: {
  name?: string
  triggerDescription?: string
  priority?: number
  reentryMode?: RoutineReentryMode
} = {}): RoutineDefinitionDraft => ({
  name: input.name ?? '',
  activation: {
    triggerDescription: input.triggerDescription ?? '',
    gateRef: null,
    priority: input.priority ?? 0,
    reentryMode: input.reentryMode ?? 'once_per_conversation',
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
  // The terminal ids + messages to emit. The chip body only references the canonical
  // `done`/`handoff`; these resolve those refs to the actual terminal the routine keeps.
  terminals?: ProseTerminalConfig
  // Completion export config carried alongside the body (not encoded in chips). Included on
  // the draft only when enabled.
  completionExport?: RoutineCompletionExport | null
}): RoutineDefinitionDraft {
  // Keep blocks with prose or chips (a branch can be pure chips: a condition + target).
  const blocks = input.blocks.filter((block) => block.text.trim().length > 0 || block.chips.length > 0)

  // Resolve the terminal config to concrete ids + messages. A canonical end/handoff ref in
  // the body maps to these ids; a fresh draft defaults to `done` (null copy) and `handoff`
  // (default copy).
  const completeId = input.terminals?.complete?.id?.trim() || DONE_TERMINAL_ID
  const completeInstruction = input.terminals?.complete?.instruction?.trim() || null
  const handoffId = input.terminals?.handoff?.id?.trim() || HANDOFF_TERMINAL_ID
  const handoffInstruction = input.terminals?.handoff?.instruction?.trim() || DEFAULT_HANDOFF_INSTRUCTION
  const completionExport: RoutineCompletionExport | undefined = input.completionExport?.enabled
    ? {
        enabled: true,
        triggerKinds: input.completionExport.triggerKinds.length > 0
          ? input.completionExport.triggerKinds
          : ['complete'],
        destinationRef: input.completionExport.destinationRef.trim(),
      }
    : undefined
  // Map a canonical terminal ref carried on a chip to the configured terminal id.
  const resolveTerminalRef = (ref: string): string =>
    ref === DONE_TERMINAL_ID ? completeId : ref === HANDOFF_TERMINAL_ID ? handoffId : ref

  // A `decision` chip declares an approval's capture key + choices (labels), authored inline.
  // Collected up front so a branch line that conditions on the decision (`@decision is deny`)
  // is recognised as a decision guard — its field ref is `<captureKey>.id`, not a plain slot.
  const decisionOptions = new Map<string, ApprovalDocOption[]>()
  for (const block of blocks) {
    for (const chip of block.chips) {
      if (chip.kind === 'decision') {
        decisionOptions.set(chip.captureKey ?? chip.refId, chip.options ?? [])
      }
    }
  }

  // Used slots come from any block — step instructions and branch conditions both count.
  const usedSlotIds = new Set<string>()
  for (const block of blocks) {
    for (const match of block.text.matchAll(SLOT_REFERENCE)) {
      usedSlotIds.add(match[1]!)
    }
    // A condition chip branches on a variable — that's a slot reference too. A condition on a
    // decision is not a slot (the capture key isn't a declared variable), and an outcome guard
    // branches on a step result, not a slot, so skip both.
    for (const chip of block.chips) {
      if (chip.kind === 'condition' && !decisionOptions.has(chip.refId) && chip.refId !== OUTCOME_GUARD_REF) usedSlotIds.add(chip.refId)
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
      // A variable defaults to required; only an explicit `required: false` makes it optional.
      required: variable.required ?? true,
      description: variable.name,
      // Only carry the mutable flag when set, so a non-mutable slot stays `mutable: undefined`.
      ...(variable.mutable ? { mutable: true } : {}),
      ordinal: index,
    }))

  const steps: RoutineDefinitionDraft['steps'] = []
  const transitions: RoutineDefinitionDraft['transitions'] = []
  let needHandoffTerminal = false
  let lastStepId: string | null = null
  // True when the last step already defines all of its own outgoing edges (an approval
  // gate routes only through its option branches), so the chain shouldn't add a default
  // edge into or out of it.
  let lastStepRoutes = false
  // True when the last step is an approval/decision gate: its outgoing edges are the decision
  // branches (authored as following branch lines), so the chain must never add a default edge
  // out of it — but those branch lines DO attach to it (unlike `lastStepRoutes`).
  let lastStepIsDecision = false
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
    if (condition && isOutcomeConditionChip(condition)) {
      // An outcome guard branches on the preceding tool step's result status (held in the
      // chip's `value`). The backend validates that fromStep is actually a tool step.
      transitions.push({
        fromStep,
        toRef,
        guardKind: 'outcome',
        guardText: null,
        outcomeStatus: String(condition.value).trim(),
        counterLimit: null,
        ordinal: ordinal++,
      })
    } else if (condition?.op) {
      // A condition on a decision branches on the chosen option id: `<captureKey>.id`. A
      // condition on an ordinary slot branches on the slot itself.
      const fieldRef = decisionOptions.has(condition.refId) ? `${condition.refId}.id` : condition.refId
      transitions.push({
        fromStep,
        toRef,
        guardKind: 'field',
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        fieldRef,
        fieldOp: condition.op,
        fieldValue: condition.value ?? null,
        fieldValues: condition.values ?? null,
        fieldUnit: condition.unit ?? null,
        ordinal: ordinal++,
      })
    } else if (condition && typeof condition.value === 'string' && condition.value.trim()) {
      // A decided-by-AI condition chip: no operator, just the comparison in prose. It carries
      // its phrase in `value` so it stays a togglable chip (vs bare prose) and compiles to an
      // `llm` guard — the AI judges the phrase at runtime.
      transitions.push({
        fromStep,
        toRef,
        guardKind: 'llm',
        guardText: condition.value.trim(),
        outcomeStatus: null,
        counterLimit: null,
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
    // An approval chip is a whole gate: an `approval` step plus one deterministic
    // field-guard edge per option (routing lives on the chip, not in following branch
    // paragraphs). It defines all its own outgoing edges, so the chain skips it.
    const approvalChip = block.chips.find((chip) => chip.kind === 'approval')
    if (approvalChip) {
      flushTitledBody()
      titledStep = null
      // An approval gate is always a single (untitled) step: its routing rides on the chip,
      // not on a heading, so it round-trips as one paragraph.
      const id = `step_${steps.length + 1}`
      const captureKey = approvalChip.captureKey ?? ''
      const options = approvalChip.options ?? []
      steps.push({
        stableStepId: id,
        kind: 'approval',
        // Every step needs a non-empty instruction (backend requirement); fall back to the
        // capture key when the approval chip carries no prose.
        instruction: block.text.trim() || captureKey || 'Make a decision',
        toolRef: null,
        actionType: null,
        captureKey: captureKey || null,
        options: options.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
        ordinal: steps.length,
        metadata: {},
      })
      if (lastStepId && !lastStepRoutes && !lastStepIsDecision) {
        transitions.push({ fromStep: lastStepId, toRef: id, guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, ordinal: ordinal++ })
      }
      const branches = options
        .filter((option): option is ApprovalDocOption & { target: string } => Boolean(option.target))
        .map((option) => ({ optionId: option.id, target: option.target }))
      for (const branch of branches) {
        if (branch.target === HANDOFF_TERMINAL_ID) needHandoffTerminal = true
      }
      // Resolve canonical end/handoff refs on each option to the configured terminal ids.
      transitions.push(...approvalOptionTransitions(
        id,
        captureKey,
        branches.map((branch) => ({ ...branch, target: resolveTerminalRef(branch.target) })),
        () => ordinal++,
      ))
      lastStepId = id
      lastStepRoutes = true
      lastStepIsDecision = false
      continue
    }
    // A `decision` chip declares the same approval gate, but inline: the chip carries only the
    // capture key + choices (labels), and the routing lives on ordinary branch lines that
    // follow (`@decision is deny → handoff`). Same `approval` step + field guards as the block
    // chip — just authored, and editable, as prose.
    const decisionChip = block.chips.find((chip) => chip.kind === 'decision')
    if (decisionChip) {
      flushTitledBody()
      titledStep = null
      const id = `step_${steps.length + 1}`
      const captureKey = decisionChip.captureKey ?? decisionChip.refId ?? ''
      const options = decisionChip.options ?? []
      steps.push({
        stableStepId: id,
        kind: 'approval',
        instruction: block.text.trim() || captureKey || 'Make a decision',
        toolRef: null,
        actionType: null,
        captureKey: captureKey || null,
        options: options.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
        ordinal: steps.length,
        metadata: {},
      })
      if (lastStepId && !lastStepRoutes && !lastStepIsDecision) {
        transitions.push({ fromStep: lastStepId, toRef: id, guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, ordinal: ordinal++ })
      }
      // The decision's edges are the branch lines that follow; they attach to this step
      // (lastStepRoutes stays false) but no default edge may leave it (lastStepIsDecision).
      lastStepId = id
      lastStepRoutes = false
      lastStepIsDecision = true
      continue
    }
    const handoffChip = block.chips.find((chip) => chip.kind === 'handoff')
    const endChip = block.chips.find((chip) => chip.kind === 'end')
    const stepChip = block.chips.find((chip) => chip.kind === 'step')
    if (handoffChip || endChip || stepChip) {
      // A branch from the step we're currently in. A `step` chip jumps to a named step;
      // otherwise the target is a terminal (handoff escalates, end completes).
      if (lastStepId && !lastStepRoutes) {
        if (stepChip) {
          branchFrom(lastStepId, stepChip.refId, block)
        } else {
          if (handoffChip) needHandoffTerminal = true
          branchFrom(lastStepId, handoffChip ? handoffId : completeId, block)
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
      if (lastStepId && !lastStepRoutes && !lastStepIsDecision) {
        transitions.push({ fromStep: lastStepId, toRef: id, guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, ordinal: ordinal++ })
      }
      lastStepId = id
      lastStepRoutes = false
      lastStepIsDecision = false
      titledStep = { step, body: [] }
      continue
    }
    // A skill chip turns the step into a tool step the runner dispatches through the skill
    // port; an action chip turns it into an action step that emits an outbox action (named by
    // its action type). Both reference something defined elsewhere by name.
    const skillChip = block.chips.find((chip) => chip.kind === 'skill')
    const actionChip = block.chips.find((chip) => chip.kind === 'action')
    const instruction = block.text.trim()
    if (!instruction && !skillChip && !actionChip) {
      // A non-branch block with no prose (e.g. an orphan condition chip) isn't a step.
      continue
    }
    if (titledStep) {
      // Body of the current titled step (a skill chip makes it a tool step; an action chip an
      // action step).
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
      } else if (actionChip) {
        titledStep.step.kind = 'action'
        titledStep.step.actionType = actionChip.refId
      }
      flushTitledBody()
      continue
    }
    const id = `step_${steps.length + 1}`
    steps.push({
      stableStepId: id,
      kind: actionChip ? 'action' : skillChip ? 'tool' : 'chat',
      // Every step needs a non-empty instruction (backend requirement). A skill or action chip
      // alone on a line carries no prose, so fall back to the referenced name.
      instruction: instruction || (actionChip?.refId ?? skillChip?.refId ?? ''),
      toolRef: skillChip ? skillChip.refId : null,
      actionType: actionChip ? actionChip.refId : null,
      ordinal: steps.length,
      metadata: skillChip
        ? {
            inputBindings: skillChip.inputBindings ?? {},
            outputAssignments: skillChip.outputAssignments ?? {},
            mode: skillChip.mode ?? 'typed',
          }
        : {},
    })
    if (lastStepId && !lastStepRoutes && !lastStepIsDecision) {
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
    lastStepRoutes = false
    lastStepIsDecision = false
  }

  flushTitledBody()
  if (lastStepId && !lastStepRoutes && !lastStepIsDecision) {
    transitions.push({
      fromStep: lastStepId,
      toRef: completeId,
      guardKind: 'default',
      guardText: null,
      outcomeStatus: null,
      counterLimit: null,
      ordinal: ordinal++,
    })
  }

  const terminals: RoutineDefinitionDraft['terminals'] = [
    { stableStepId: completeId, kind: 'complete', instruction: completeInstruction, ordinal: 0 },
  ]
  if (needHandoffTerminal) {
    terminals.push({ stableStepId: handoffId, kind: 'handoff', instruction: handoffInstruction, ordinal: 1 })
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
    // Carry completion export through only when enabled, so a routine without it stays clean.
    ...(completionExport ? { completionExport } : {}),
  }
}

// One inline piece of a loaded prose paragraph: literal text or a chip. This is the
// richer shape draftFromChipDoc's flat {text, chips} can't carry — it preserves where
// each chip sits inline — so the editor can rebuild the Lexical document on load.
export type ProseChipKind = 'variable' | 'skill' | 'action' | 'handoff' | 'step' | 'condition' | 'end' | 'approval' | 'decision'
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
      // For an `approval` chip: the capture slot and the options (each with its target).
      captureKey?: string | null
      options?: ApprovalDocOption[]
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
    // A decided-by-AI guard renders as an AI-mode condition chip (no operator), carrying its
    // phrase in `value`. Keeping it a chip — not bare text — means it stays togglable back to
    // decided-in-code after a reload (issue: "once decided by AI, can't go back").
    return [{ kind: 'chip', chipKind: 'condition', refId: '', label: edge.guardText, value: edge.guardText }]
  }
  // An outcome guard's status is in `outcomeStatus`, or (legacy/Form-equivalent) in `guardText`
  // — the compiler reads `outcomeStatus ?? guardText`, so accept either.
  const outcomeStatus = edge.guardKind === 'outcome' ? (edge.outcomeStatus ?? edge.guardText) : null
  if (outcomeStatus) {
    // An outcome guard renders as an outcome-mode condition chip: the sentinel refId marks it
    // as a step-result branch (not a variable comparison) and the status rides in `value`.
    return [{ kind: 'chip', chipKind: 'condition', refId: OUTCOME_GUARD_REF, label: `outcome is ${outcomeStatus}`, value: outcomeStatus }]
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
// Chat/tool/action steps and field/llm/counter/outcome guards round-trip; it returns null for
// shapes the prose editor can't show — slot_filled guards, an outcome guard with no status, an
// action step with no action type, a jump to a step whose id is not a clean slug, multiple
// complete/handoff terminals, or an activation gate — so the caller falls back to the form
// editor rather than silently dropping that configuration. Routine-level config the body does
// not encode — the complete/handoff terminal id + message and the completion export — is not
// dropped: the host reads it with readProseTerminals / readProseCompletionExport and feeds it
// back to draftFromChipDoc, so it round-trips even though the body only references the
// canonical `done`/`handoff`.
export function routineToChipDoc(routine: RoutineDefinitionDraft): ProseDoc | null {
  if (routine.activation.gateRef) return null

  const steps = [...routine.steps].sort((left, right) => left.ordinal - right.ordinal)
  if (steps.some((step) => step.kind !== 'chat' && step.kind !== 'tool' && step.kind !== 'approval' && step.kind !== 'action')) return null
  if (steps.some((step) => step.kind === 'tool' && !step.toolRef)) return null
  // An action step with no action type can't be shown as an action chip.
  if (steps.some((step) => step.kind === 'action' && !step.actionType)) return null
  // Fall back to Form for any step whose metadata the prose round-trip can't carry faithfully:
  // an unpreservable key (authored passthrough metadata, or binding state on a non-tool step),
  // or an outline label that doesn't slugify back to the step's id (the heading would rename
  // the step, changing its id and every transition that targets it).
  if (steps.some((step) => !stepMetadataIsRepresentable(step))) return null

  // Prose collapses to a single complete terminal and at most one handoff. More than one of
  // either is a real multi-ending graph that only the Form view can author.
  const completeTerminals = routine.terminals.filter((terminal) => terminal.kind === 'complete')
  const handoffTerminals = routine.terminals.filter((terminal) => terminal.kind === 'handoff')
  if (completeTerminals.length !== 1) return null
  if (handoffTerminals.length > 1) return null
  if (routine.terminals.length !== completeTerminals.length + handoffTerminals.length) return null

  const complete = completeTerminals[0]!
  const handoff = handoffTerminals[0]
  const completeId = complete.stableStepId
  const handoffId = handoff?.stableStepId ?? null
  // A handoff terminal is rendered only as the target of a handoff branch. One that no
  // transition targets would be silently dropped on a round-trip (draftFromChipDoc only emits
  // the handoff terminal when a handoff chip is present), so fall back to Form.
  if (handoff && !routine.transitions.some((transition) => transition.toRef === handoff.stableStepId)) return null
  const stepIds = new Set(steps.map((step) => step.stableStepId))
  if (routine.transitions.some((transition) => !stepIds.has(transition.fromStep))) return null

  const variables: ChipDocVariable[] = [...routine.slots]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((slot) => ({
      id: slot.key,
      name: (slot.description ?? '').trim() || slot.key,
      type: slot.type,
      // Mirror draftFromChipDoc: emit the flags only when non-default so a plain required,
      // non-mutable slot stays the bare `{ id, name, type }` shape.
      ...(slot.required === false ? { required: false } : {}),
      ...(slot.mutable ? { mutable: true } : {}),
    }))
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

  // Steps a non-default edge points at (a jump, a conditional/outcome branch, an approval
  // option) need a stable name so the prose `step` chip and its heading can target them.
  const jumpTargetIds = new Set<string>()
  for (const transition of routine.transitions) {
    if (transition.guardKind !== 'default' && stepIds.has(transition.toRef)) jumpTargetIds.add(transition.toRef)
  }
  // A readable heading synthesized from a step id (`resolve_billing` -> "Resolve Billing").
  // The jump targets the step by id, so the synthesized title must slugify back to the exact
  // id or it can't be used — this lets a Form step (no author label) become targetable when
  // its id is a clean slug, and falls back to Form otherwise.
  const titleFromId = (id: string): string | null => {
    const humanized = id.split('_').filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
    if (humanized && slugifyVariableKey(humanized) === id) return humanized
    if (slugifyVariableKey(id) === id) return id
    return null
  }
  const titleByStepId = new Map(steps.map((step) => {
    const label = titleOf(step)
    if (label) return [step.stableStepId, label] as const
    // Only jump targets get a synthesized title; other untitled steps stay one-line.
    return [step.stableStepId, jumpTargetIds.has(step.stableStepId) ? titleFromId(step.stableStepId) : null] as const
  }))

  // Map an approval option's branch target (a step/terminal id) to the id the chip carries:
  // the complete/handoff terminals collapse to their prose constants; a step target must be
  // titled (so it round-trips by name) or the routine edits in Form.
  const approvalDocTarget = (target: string): string | null => {
    if (target === completeId) return DONE_TERMINAL_ID
    if (handoffId && target === handoffId) return HANDOFF_TERMINAL_ID
    if (stepIds.has(target)) return titleByStepId.get(target) ? target : null
    return null
  }

  const paragraphs: ProseParagraph[] = []
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!
    // Includes a title synthesized for an untitled jump target, so it renders as a heading.
    const title = titleByStepId.get(step.stableStepId) ?? null
    if (step.kind === 'approval') {
      // An approval gate renders inline: a `decision` declaration chip (the choices + labels)
      // followed by one ordinary branch line per option — "if <decision> is <choice> then
      // <target>". Each decision edge is one `<captureKey>.id == <option>` field guard.
      if (title) return null
      const captureKey = step.captureKey ?? ''
      const stepOutgoing = [...(outgoing.get(step.stableStepId) ?? [])].sort((left, right) => left.ordinal - right.ordinal)
      const decisionRef = `${captureKey}.id`
      const declaredOptions = step.options ?? []
      const declaredOptionIds = new Set(declaredOptions.map((option) => option.id))
      // Every edge must be a decision field guard on `<captureKey>.id` to a declared option.
      // Zero edges is allowed: a fully-unwired gate (choices declared, no branches routed yet)
      // renders as just the declaration, the same way a partially-wired one renders only its
      // routed options — so the author can finish wiring it in prose instead of being bounced.
      const cleanEdges = stepOutgoing.every((edge) =>
        edge.guardKind === 'field'
        && edge.fieldRef === decisionRef
        && edge.fieldOp === 'equals'
        && typeof edge.fieldValue === 'string'
        && declaredOptionIds.has(edge.fieldValue))
      if (!captureKey || !cleanEdges) return null
      const optionLabels = new Map(declaredOptions.map((option) => [option.id, option.label] as const))
      // The declaration: choices + labels, no targets (those live on the branch lines).
      const declSegments = parseInstructionSegments(step.instruction ?? '', nameByRef)
      declSegments.push({
        kind: 'chip',
        chipKind: 'decision',
        refId: captureKey,
        label: 'decision',
        captureKey,
        options: declaredOptions.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
      })
      paragraphs.push({ segments: declSegments })
      // One inline branch line per decision edge.
      for (const edge of stepOutgoing) {
        const optionId = edge.fieldValue as string
        const docTarget = approvalDocTarget(edge.toRef)
        if (docTarget === null) return null
        const condition: ProseSegment = {
          kind: 'chip',
          chipKind: 'condition',
          refId: captureKey,
          op: 'equals',
          value: optionId,
          label: `${captureKey} is ${optionLabels.get(optionId) ?? optionId}`,
        }
        const target: ProseSegment = docTarget === DONE_TERMINAL_ID
          ? { kind: 'chip', chipKind: 'end', refId: DONE_TERMINAL_ID, label: 'end' }
          : docTarget === HANDOFF_TERMINAL_ID
            ? { kind: 'chip', chipKind: 'handoff', refId: HANDOFF_TERMINAL_ID, label: HANDOFF_CHIP_LABEL }
            : { kind: 'chip', chipKind: 'step', refId: docTarget, label: titleByStepId.get(docTarget) ?? docTarget }
        paragraphs.push({ segments: [condition, target] })
      }
      continue
    }
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
      if (step.kind === 'action' && step.actionType) {
        bodySegments.push({ kind: 'chip', chipKind: 'action', refId: step.actionType, label: step.actionType })
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
      if (step.kind === 'action' && step.actionType) {
        segments.push({ kind: 'chip', chipKind: 'action', refId: step.actionType, label: step.actionType })
      }
      paragraphs.push({ segments })
    }

    // A step continues via exactly one default edge (to the next step, or the complete
    // terminal for the last step). Non-default edges are branches: llm/field/outcome to a
    // terminal (handoff/end), or llm/field/counter/outcome to another step (a jump — a counter
    // bound makes it a safe backward loop). A jump can only target a titled step (it needs a
    // stable name). An outcome guard must carry a status. Anything else isn't prose-shaped.
    const chainTarget = steps[index + 1]?.stableStepId ?? completeId
    // True when a guard prefix (condition chip / AI prose / outcome chip) can render. Each
    // requires its defining field: an llm guard needs a non-null guardText — a `null` one
    // compiles to the condition `"llm"` but a bare prose round-trip would emit `""`, a
    // different condition (an empty `""` already round-trips to `""`, so it stays); a field
    // guard needs ref+operator; an outcome guard a status. Otherwise the prose would
    // round-trip to a different guard, so it falls back.
    const guardRenders = (edge: RoutineTransition): boolean =>
      (edge.guardKind === 'llm' && edge.guardText != null)
      || (edge.guardKind === 'field' && Boolean(edge.fieldRef) && Boolean(edge.fieldOp))
      || (edge.guardKind === 'outcome' && Boolean(edge.outcomeStatus ?? edge.guardText))
    // A counter jump's bound rides on the step chip's counterLimit; one whose limit lives only
    // in guardText would round-trip to an unbounded (llm) jump, so require the explicit limit.
    const counterRenders = (edge: RoutineTransition): boolean =>
      edge.guardKind === 'counter' && edge.counterLimit != null
    let sawChain = false
    for (const edge of [...(outgoing.get(step.stableStepId) ?? [])].sort((left, right) => left.ordinal - right.ordinal)) {
      if (edge.guardKind === 'default') {
        if (sawChain || edge.toRef !== chainTarget) return null
        sawChain = true
      } else if (handoffId && edge.toRef === handoffId && guardRenders(edge)) {
        paragraphs.push(branchParagraph(edge, nameByRef, { kind: 'chip', chipKind: 'handoff', refId: HANDOFF_TERMINAL_ID, label: HANDOFF_CHIP_LABEL }))
      } else if (edge.toRef === completeId && guardRenders(edge)) {
        paragraphs.push(branchParagraph(edge, nameByRef, { kind: 'chip', chipKind: 'end', refId: DONE_TERMINAL_ID, label: 'end' }))
      } else if (stepIds.has(edge.toRef) && (guardRenders(edge) || counterRenders(edge))) {
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
