import {
  OUTCOME_GUARD_REF,
  SLOT_FILLED_GUARD_REF,
  type ApprovalDocOption,
  type ChipDocVariable,
  type ProseParagraph,
  type ProseSegment,
  type RoutineDraftSource,
  type RoutineDraftSourceStep,
  type RoutineDraftSourceTerminal,
  type RoutineDraftSourceTransition,
  type RoutineFieldGuardOp,
  type RoutineFieldGuardUnit,
  type RoutineFieldGuardValue,
  type RoutineInputBinding,
  type RoutineCompletionExport,
  type ProseTerminal,
  type RoutineSlotType,
  type RoutineStepMode,
} from './types.js'

export const ROUTINE_SLOT_TYPES: RoutineSlotType[] = ['text', 'number', 'boolean', 'email', 'date']
export const ROUTINE_FIELD_GUARD_UNITS: RoutineFieldGuardUnit[] = ['days', 'weeks', 'months', 'years']

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

export const SLOT_REFERENCE = /\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

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

// Step metadata keys the chip document preserves. The skill-binding state only round-trips on
// a tool step (it rides on the skill chip); the outline label (a titled step's heading) can
// ride on any step. Any other key — or binding state on a non-tool step — is authored metadata
// the prose round-trip can't carry, so routineToChipDoc falls back to Form when it sees one.
const PRESERVED_TOOL_METADATA_KEYS = new Set(['inputBindings', 'outputAssignments', 'mode', 'outlineLabel'])
const OUTLINE_LABEL_ONLY = new Set(['outlineLabel'])

// True when a step's metadata round-trips through the chip document without loss or renaming.
function stepMetadataIsRepresentable(step: RoutineDraftSourceStep): boolean {
  const metadata = (step.metadata ?? {}) as Record<string, unknown>
  const allowed = step.kind === 'tool' ? PRESERVED_TOOL_METADATA_KEYS : OUTLINE_LABEL_ONLY
  if (Object.keys(metadata).some((key) => !allowed.has(key))) return false
  // An outline label round-trips only as a heading whose text slugifies back into the step
  // id. So whenever the key is present it must be a non-empty string that
  // slugifies to the existing id; an empty or non-string label would be silently dropped (it
  // is authored metadata the compiler keeps), and a mismatching one would rename the step.
  if ('outlineLabel' in metadata) {
    const label = metadata.outlineLabel
    if (typeof label !== 'string' || !label.trim() || slugifyVariableKey(label.trim()) !== step.stableStepId) return false
  }
  return true
}

// The distinct `{{slot.<key>}}` references in a transition's guardText, in first-seen order.
// Mirrors the backend's collectSlotKeys so a slot_filled guard round-trips the same slot set
// the compiler reads.
function collectGuardSlotKeys(guardText: string | null | undefined): string[] {
  const keys = new Set<string>()
  for (const match of (guardText ?? '').matchAll(SLOT_REFERENCE)) {
    const key = match[1]
    if (key) keys.add(key)
  }
  return [...keys]
}

// Readable "when <a> and <b> are provided" label for a slot-filled guard chip.
export function formatSlotFilledLabel(keys: string[], nameByRef: Map<string, string>): string {
  const names = keys.map((key) => nameByRef.get(key) ?? key)
  const list = names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `when ${list} ${names.length > 1 ? 'are' : 'is'} provided`
}

// The terminal id + message the prose editor preserves outside the chip body (the body only
// references the canonical `done`/`handoff`). Fields are optional: an omitted id defaults to
// the canonical terminal id, and an omitted completion message defaults to null / the handoff
// message to the default copy.
// Read the complete/handoff terminal config off a routine so the prose host can edit the
// messages and re-emit the same ids. Returns the *primary* complete (the fall-through end a
// default edge targets, else the first) for the header panel; additional named completions carry
// their own message on their end chip. At most one handoff; other shapes fall back to Form.
export function readProseTerminals(routine: RoutineDraftSource): { complete: ProseTerminal; handoff: ProseTerminal | null } {
  const terminals = routine.terminals ?? []
  const transitions = routine.transitions ?? []
  const completes = terminals.filter((terminal) => terminal.kind === 'complete')
  const complete = completes.find((terminal) =>
    transitions.some((transition) => transition.guardKind === 'default' && transition.toRef === terminal.stableStepId))
    ?? completes[0]
  const handoff = terminals.find((terminal) => terminal.kind === 'handoff')
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
export function readProseCompletionExport(routine: RoutineDraftSource): RoutineCompletionExport | null {
  const source = routine.completionExport
  if (!source?.enabled) return null
  return {
    enabled: true,
    triggerKinds: source.triggerKinds ?? [],
    destinationRef: source.destinationRef ?? '',
  }
}

type ProseDoc = { variables: ChipDocVariable[]; paragraphs: ProseParagraph[] }

const HANDOFF_CHIP_LABEL = 'handoff'

function parseInstructionSegments(instruction: string, nameByRef: Map<string, string>): ProseSegment[] {
  const segments: ProseSegment[] = []
  let lastIndex = 0
  for (const match of instruction.matchAll(SLOT_REFERENCE)) {
    const index = match.index ?? 0
    if (index > lastIndex) segments.push({ kind: 'text', text: instruction.slice(lastIndex, index) })
    const refId = match[1]
    segments.push({ kind: 'chip', chipKind: 'variable', refId, label: `@${nameByRef.get(refId) ?? refId}` })
    lastIndex = index + match[0].length
  }
  if (lastIndex < instruction.length) segments.push({ kind: 'text', text: instruction.slice(lastIndex) })
  return segments.length > 0 ? segments : [{ kind: 'text', text: instruction }]
}

function fieldGuardIsRepresentable(edge: RoutineDraftSourceTransition): boolean {
  if (edge.guardKind !== 'field' || !edge.fieldRef || !edge.fieldOp) return false
  if (!fieldGuardOpNeedsValue(edge.fieldOp)) return true
  if (edge.fieldOp === 'in') return Array.isArray(edge.fieldValues) && edge.fieldValues.length > 0
  if (fieldGuardOpNeedsUnit(edge.fieldOp)) {
    return typeof edge.fieldValue === 'number' && edge.fieldUnit != null
  }
  return edge.fieldValue !== null && edge.fieldValue !== undefined
}

// The guard prefix of a branch paragraph: a condition chip (decided-in-code), or the
// AI-decided prose. A counter-bounded loop has no prose prefix — the bound rides on the
// trailing step chip — so it returns nothing here.
function branchGuardSegments(edge: RoutineDraftSourceTransition, nameByRef: Map<string, string>): ProseSegment[] {
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
    // A decided-by-AI guard renders as a bare AI⇄code selector chip (no operator, no phrase
    // payload) followed by the phrase as ordinary editable text. The chip keeps the guard
    // togglable back to decided-in-code after a reload (issue: "once decided by AI, can't go
    // back"); splitting the phrase out as text keeps it fully fluid (issue: "the AI phrase
    // freezes into a chip once the routine is validated/published").
    return [
      { kind: 'chip', chipKind: 'condition', refId: '', label: '' },
      { kind: 'text', text: edge.guardText },
    ]
  }
  // An outcome guard's status is in `outcomeStatus`, or (legacy/Form-equivalent) in `guardText`
  // — the compiler reads `outcomeStatus ?? guardText`, so accept either.
  const outcomeStatus = edge.guardKind === 'outcome' ? (edge.outcomeStatus ?? edge.guardText) : null
  if (outcomeStatus) {
    // An outcome guard renders as an outcome-mode condition chip: the sentinel refId marks it
    // as a step-result branch (not a variable comparison) and the status rides in `value`.
    return [{ kind: 'chip', chipKind: 'condition', refId: OUTCOME_GUARD_REF, label: `outcome is ${outcomeStatus}`, value: outcomeStatus }]
  }
  if (edge.guardKind === 'slot_filled') {
    // A slot-filled guard renders as a slot-filled-mode condition chip: the sentinel refId marks
    // it as a slot-presence gate and the slot set rides in `values` (the compiler's slot keys).
    const keys = collectGuardSlotKeys(edge.guardText)
    return [{ kind: 'chip', chipKind: 'condition', refId: SLOT_FILLED_GUARD_REF, label: formatSlotFilledLabel(keys, nameByRef), values: keys }]
  }
  return []
}

// A branch paragraph = the guard prefix followed by the target chip (handoff/end terminal
// or a `step` jump chip).
function branchParagraph(edge: RoutineDraftSourceTransition, nameByRef: Map<string, string>, trailing: ProseSegment): ProseParagraph {
  return { segments: [...branchGuardSegments(edge, nameByRef), trailing] }
}

// Projects a routine into the chip document (variables + paragraphs with inline chips) used
// by the read-only portable text the operator copilot reads — see
// backend/src/modules/routines/portableDocument.ts. One direction only: nothing parses this
// text back into a routine. Chat/tool/action steps and field/llm/counter/outcome/slot_filled
// guards project cleanly; it returns null for shapes the chip format can't show — an outcome
// guard with no status, a slot_filled guard that names no slots, an action step with no action
// type, a jump to a step whose id is not a clean slug, multiple complete/handoff terminals, or
// an activation gate — so the caller falls back to another representation rather than silently
// dropping that configuration. Routine-level config the body does not encode — the
// complete/handoff terminal id + message and the completion export — is not dropped: the host
// reads it separately with readProseTerminals / readProseCompletionExport, since the body only
// references the canonical `done`/`handoff`.
export function routineToChipDoc(routine: RoutineDraftSource): ProseDoc | null {
  if (routine.activation.gateRef) return null

  const transitions = routine.transitions ?? []
  const steps = [...(routine.steps ?? [])].sort((left, right) => left.ordinal - right.ordinal)
  if (steps.some((step) => step.kind !== 'chat' && step.kind !== 'tool' && step.kind !== 'approval' && step.kind !== 'action')) return null
  if (steps.some((step) => step.kind === 'tool' && !step.toolRef)) return null
  // An action step with no action type can't be shown as an action chip.
  if (steps.some((step) => step.kind === 'action' && !step.actionType)) return null
  // Fall back to Form for any step whose metadata the prose round-trip can't carry faithfully:
  // an unpreservable key (authored passthrough metadata, or binding state on a non-tool step),
  // or an outline label that doesn't slugify back to the step's id (the heading would rename
  // the step, changing its id and every transition that targets it).
  if (steps.some((step) => !stepMetadataIsRepresentable(step))) return null

  // Prose supports one or more complete terminals and at most one handoff. The "primary"
  // complete (the fall-through end whose id + message live in the header panel) is the one a
  // default edge targets, else the first by ordinal; every other complete is a named ending
  // whose message rides on its end chip. More than one handoff is still Form-only.
  const terminals = routine.terminals ?? []
  const completeTerminals = terminals.filter((terminal) => terminal.kind === 'complete')
  const handoffTerminals = terminals.filter((terminal) => terminal.kind === 'handoff')
  if (completeTerminals.length < 1) return null
  if (handoffTerminals.length > 1) return null
  if (terminals.length !== completeTerminals.length + handoffTerminals.length) return null

  const primaryComplete = completeTerminals.find((terminal) =>
    transitions.some((transition) => transition.guardKind === 'default' && transition.toRef === terminal.stableStepId))
    ?? completeTerminals[0]
  const completeById = new Map(completeTerminals.map((terminal) => [terminal.stableStepId, terminal] as const))
  const handoff = handoffTerminals[0]
  const completeId = primaryComplete.stableStepId
  const handoffId = handoff?.stableStepId ?? null
  // A handoff terminal is rendered only as the target of a handoff branch. One that no
  // transition targets would be silently missing from the projected text, so fall back to Form.
  if (handoff && !transitions.some((transition) => transition.toRef === handoff.stableStepId)) return null
  // A named ending is rendered only as the target of an end branch. One that no transition
  // reaches (or that only a default fall-through reaches — that's the primary) would be dropped
  // on a round-trip, so fall back to Form. The primary complete needs no incoming branch (it is
  // the fall-through), so it is exempt.
  const namedCompleteReachable = (terminal: RoutineDraftSourceTerminal): boolean =>
    transitions.some((transition) => transition.guardKind !== 'default' && transition.toRef === terminal.stableStepId)
  if (completeTerminals.some((terminal) => terminal.stableStepId !== completeId && !namedCompleteReachable(terminal))) return null
  const stepIds = new Set(steps.map((step) => step.stableStepId))
  if (transitions.some((transition) => !stepIds.has(transition.fromStep))) return null

  const variables: ChipDocVariable[] = [...(routine.slots ?? [])]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((slot) => ({
      id: slot.key,
      name: (slot.description ?? '').trim() || slot.key,
      type: slot.type,
      // Emit the flags only when non-default so a plain required, non-mutable slot stays the
      // bare `{ id, name, type }` shape.
      ...(slot.required === false ? { required: false } : {}),
      ...(slot.mutable ? { mutable: true } : {}),
    }))
  const nameByRef = new Map(variables.map((variable) => [variable.id, variable.name]))

  const outgoing = new Map<string, RoutineDraftSourceTransition[]>()
  for (const transition of transitions) {
    const list = outgoing.get(transition.fromStep) ?? []
    list.push(transition)
    outgoing.set(transition.fromStep, list)
  }

  const titleOf = (step: RoutineDraftSourceStep): string | null => {
    const label = (step.metadata)?.outlineLabel
    return typeof label === 'string' && label.trim() ? label.trim() : null
  }

  // Steps a non-default edge points at (a jump, a conditional/outcome branch, an approval
  // option) need a stable name so the prose `step` chip and its heading can target them.
  const jumpTargetIds = new Set<string>()
  for (const transition of transitions) {
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
    const step = steps[index]
    // Includes a title synthesized for an untitled jump target, so it renders as a heading.
    const title = titleByStepId.get(step.stableStepId) ?? null
    if (step.kind === 'approval') {
      // An approval gate renders inline: a `decision` declaration chip (the choices + labels)
      // followed by one ordinary branch line per option — "if <decision> is <choice> then
      // <target>". Each decision edge is one `<captureKey>.id == <option>` field guard. A titled
      // gate (an author label, or a synthesized heading because a jump targets it) renders its
      // name as an h1 heading above the declaration, the same way a titled chat/tool step does.
      if (title) paragraphs.push({ headingLevel: 1, segments: [{ kind: 'text', text: title }] })
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
      // The declaration: choices + labels, no targets (those live on the branch lines). Under a
      // heading, drop a body that just echoes the title (like a titled chat/tool step) so the
      // gate prompt isn't duplicated as both heading and body.
      const declBody = title && (step.instruction ?? '') === title ? '' : (step.instruction ?? '')
      const declSegments = title && !declBody ? [] : parseInstructionSegments(declBody, nameByRef)
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
        const metadata = step.metadata
        bodySegments.push({
          kind: 'chip',
          chipKind: 'skill',
          refId: step.toolRef,
          label: `#${step.toolRef}`,
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
        const metadata = step.metadata
        segments.push({
          kind: 'chip',
          chipKind: 'skill',
          refId: step.toolRef,
          label: `#${step.toolRef}`,
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
    // terminal for the last step). Non-default edges are branches: llm/field/outcome/slot_filled
    // to a terminal (handoff/end), or llm/field/counter/outcome/slot_filled to another step (a
    // jump — a counter bound makes it a safe backward loop). A jump can only target a titled step
    // (it needs a stable name). An outcome guard must carry a status, a slot_filled guard at least
    // one slot. Anything else isn't prose-shaped.
    const chainTarget = steps[index + 1]?.stableStepId ?? completeId
    // True when a guard prefix (condition chip / AI prose / outcome chip) can render. Each
    // requires its defining field: an llm guard needs a non-null guardText — a `null` one
    // compiles to the condition `"llm"` but a bare prose round-trip would emit `""`, a
    // different condition (an empty `""` already round-trips to `""`, so it stays); a field
    // guard needs every operand the operator requires; an outcome guard a status. Otherwise the prose would
    // round-trip to a different guard, so it falls back.
    const guardRenders = (edge: RoutineDraftSourceTransition): boolean =>
      (edge.guardKind === 'llm' && edge.guardText != null)
      || fieldGuardIsRepresentable(edge)
      || (edge.guardKind === 'outcome' && Boolean(edge.outcomeStatus ?? edge.guardText))
      // A slot-filled guard renders only when guardText names at least one slot — one that names
      // none can't become a "when provided" chip, so it falls back to Form.
      || (edge.guardKind === 'slot_filled' && collectGuardSlotKeys(edge.guardText).length > 0)
    // A counter jump's bound rides on the step chip's counterLimit; one whose limit lives only
    // in guardText would round-trip to an unbounded (llm) jump, so require the explicit limit.
    const counterRenders = (edge: RoutineDraftSourceTransition): boolean =>
      edge.guardKind === 'counter' && edge.counterLimit != null
    let sawChain = false
    for (const edge of [...(outgoing.get(step.stableStepId) ?? [])].sort((left, right) => left.ordinal - right.ordinal)) {
      if (edge.guardKind === 'default') {
        if (sawChain || edge.toRef !== chainTarget) return null
        sawChain = true
      } else if (handoffId && edge.toRef === handoffId && guardRenders(edge)) {
        paragraphs.push(branchParagraph(edge, nameByRef, { kind: 'chip', chipKind: 'handoff', refId: HANDOFF_TERMINAL_ID, label: HANDOFF_CHIP_LABEL }))
      } else if (completeById.has(edge.toRef) && guardRenders(edge)) {
        // The primary complete renders as a bare `end` chip (its message is the header field); a
        // named ending carries its own id + message so the extra completion survives the round-trip.
        const endTerminal = completeById.get(edge.toRef)!
        const endChip: ProseSegment = endTerminal.stableStepId === completeId
          ? { kind: 'chip', chipKind: 'end', refId: DONE_TERMINAL_ID, label: 'end' }
          : { kind: 'chip', chipKind: 'end', refId: endTerminal.stableStepId, label: endTerminal.stableStepId, value: endTerminal.instruction ?? null }
        paragraphs.push(branchParagraph(edge, nameByRef, endChip))
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
