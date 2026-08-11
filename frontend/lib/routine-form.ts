import type {
  RoutineDefinition,
  RoutineDefinitionDraft,
  RoutineCompletionExport,
  RoutineFieldGuardOp,
  RoutineFieldGuardUnit,
  RoutineGuardKind,
  RoutineReentryMode,
  RoutineSlotType,
  RoutineStepKind,
  RoutineTerminalKind,
  RoutineTransition,
  RoutineValidationDiagnostic,
} from './api-types'
import { approvalOptionTargets, approvalOptionTransitions } from './routine-approval'

export type RoutineSlotForm = {
  stableSlotId: string
  key: string
  type: RoutineSlotType
  required: boolean
  description: string
  mutable: boolean
}

export type RoutineTransitionForm = {
  fromStep: string
  toRef: string
  guardKind: RoutineGuardKind
  guardText: string
  outcomeStatus: string
  counterLimit: string
  fieldRef: string | null
  fieldOp: RoutineFieldGuardOp | null
  fieldValue: NonNullable<RoutineTransition['fieldValue']> | null
  fieldValues: NonNullable<RoutineTransition['fieldValues']> | null
  fieldUnit: RoutineFieldGuardUnit | null
}

// An approval option as authored in the Form editor: its id/label/description plus the
// step or terminal the routine branches to when a human picks it. The target is synthesized
// into a deterministic field-guard transition on save (see formToRoutineDraft).
export type RoutineApprovalOptionForm = {
  id: string
  label: string
  description: string
  target: string
}

export type RoutineStepForm = {
  stableStepId: string
  kind: RoutineStepKind
  instruction: string
  toolRef: string
  actionType: string
  // Approval steps only: the slot the chosen option is captured under, and the options the
  // human chooses between. Empty for every other step kind.
  captureKey: string
  options: RoutineApprovalOptionForm[]
  metadata: Record<string, unknown>
  transitions: RoutineTransitionForm[]
}

export type RoutineTerminalForm = {
  stableStepId: string
  kind: RoutineTerminalKind
  instruction: string
}

export type RoutineFormState = {
  name: string
  activation: {
    triggerDescription: string
    priority: string
    reentryMode: RoutineReentryMode
  }
  slots: RoutineSlotForm[]
  steps: RoutineStepForm[]
  terminals: RoutineTerminalForm[]
  completionExport: {
    enabled: boolean
    triggerKinds: RoutineTerminalKind[]
    destinationRef: string
  }
}

export type RoutineDraftHeader = Pick<RoutineFormState, 'name' | 'activation'>

// The artifact a validation diagnostic is rendered against. Terminals share the step id
// namespace in the producer grammar, so they are addressed with the `step` scope; there is
// no `terminal` scope because the backend never emits one.
export type DiagnosticScope = 'routine' | 'slot' | 'step' | 'transition' | 'completionExport'

export type DiagnosticTarget = {
  scope: DiagnosticScope
  id: string
}

const slugify = (value: string, fallback: string): string => {
  const slug = value.trim().replace(/[^A-Za-z0-9_.-]+/gu, '_').replace(/^([^A-Za-z_])/u, '_$1')
  return slug.length > 0 ? slug : fallback
}

const nullableText = (value: string): string | null => {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

// A slot key allows only letters, digits, and underscore (stricter than a stable id, which
// also permits `.`/`-`). The approval captureKey is a slot, so it shares this normalization.
const slugifySlotKey = (value: string, fallback: string): string =>
  slugify(value, fallback).replace(/[^A-Za-z0-9_]/gu, '_')

// Draft identities.
//
// The backend validates the *draft*, so every diagnostic location names a slugified id.
// The form holds what the author typed. Anchoring a diagnostic against a raw form value
// therefore silently misses whenever the two differ (a slot key with a space, a step id
// with a `/`), so both the draft builder and the editor's diagnostic anchors go through
// these helpers — one definition of "what will this artifact be called on the wire".

export const draftSlotKey = (slot: RoutineSlotForm, index: number): string =>
  slugify(slot.key, `slot_${index + 1}`).replace(/[^A-Za-z0-9_]/gu, '_')

export const draftStepId = (step: RoutineStepForm, index: number): string =>
  slugify(step.stableStepId, `step_${index + 1}`)

export const draftTerminalId = (terminal: RoutineTerminalForm, index: number): string =>
  slugify(terminal.stableStepId, `complete_${index + 1}`)

export const draftTransitionTargetRef = (toRef: string): string => slugify(toRef, 'complete')

export const draftTransitionId = (
  step: RoutineStepForm,
  transition: RoutineTransitionForm,
): string =>
  `${slugify(transition.fromStep || step.stableStepId, step.stableStepId)}->${draftTransitionTargetRef(transition.toRef)}`

// An approval option's branch is synthesized into a field-guard transition on save, so the
// diagnostics it can attract (`approval_step_unknown_option`, `field_guard_*`) arrive under
// that edge's location rather than the step's. Returns null for an unwired option, which
// synthesizes no edge at all.
export const draftApprovalOptionTransitionId = (
  step: RoutineStepForm,
  stepIndex: number,
  option: RoutineApprovalOptionForm,
): string | null =>
  option.target.trim().length > 0
    ? `${draftStepId(step, stepIndex)}->${draftTransitionTargetRef(option.target)}`
    : null

// Every id a diagnostic's `step:`/`node:` form can name, in draft space. Terminals are in
// this set because they share the step id namespace.
export const draftNodeIds = (form: RoutineFormState): ReadonlySet<string> => new Set([
  ...form.steps.map((step, index) => draftStepId(step, index)),
  ...form.terminals.map((terminal, index) => draftTerminalId(terminal, index)),
])

type LegacyRoutineStepKind = RoutineStepKind | 'fork'
type LegacyRoutineGuardKind = RoutineGuardKind | 'always' | 'fallback'

const normalizeStepKind = (kind: LegacyRoutineStepKind): RoutineStepKind => (
  kind === 'fork' ? 'chat' : kind
)

const normalizeGuardKind = (kind: LegacyRoutineGuardKind): RoutineGuardKind => (
  kind === 'always' || kind === 'fallback' ? 'default' : kind
)

export const createEmptyRoutineForm = (): RoutineFormState => ({
  name: '',
  activation: {
    triggerDescription: '',
    priority: '0',
    reentryMode: 'once_per_conversation',
  },
  slots: [],
  steps: [{
    stableStepId: 'step_1',
    kind: 'chat',
    instruction: '',
    toolRef: '',
    actionType: '',
    captureKey: '',
    options: [],
    metadata: {},
    transitions: [],
  }],
  terminals: [{
    stableStepId: 'complete',
    kind: 'complete',
    instruction: '',
  }],
  completionExport: {
    enabled: false,
    triggerKinds: ['complete'],
    destinationRef: '',
  },
})

export const createSlotForm = (index: number): RoutineSlotForm => ({
  stableSlotId: `slot_${index + 1}`,
  key: `slot_${index + 1}`,
  type: 'text',
  required: true,
  description: '',
  mutable: false,
})

export const createStepForm = (index: number): RoutineStepForm => ({
  stableStepId: `step_${index + 1}`,
  kind: 'chat',
  instruction: '',
  toolRef: '',
  actionType: '',
  captureKey: '',
  options: [],
  metadata: {},
  transitions: [],
})

export const createApprovalOptionForm = (index: number): RoutineApprovalOptionForm => ({
  id: `option_${index + 1}`,
  label: '',
  description: '',
  target: '',
})

// A fresh approval gate seeds the two choices every approval needs — approve and decline —
// so the author starts from a real decision (the validator requires at least two) and only
// has to point each at a branch. Targets stay empty so the author wires them deliberately.
export const createDefaultApprovalOptions = (): RoutineApprovalOptionForm[] => ([
  { id: 'approve', label: 'Approve', description: '', target: '' },
  { id: 'decline', label: 'Decline', description: '', target: '' },
])

export const createTerminalForm = (index: number): RoutineTerminalForm => ({
  stableStepId: `complete_${index + 1}`,
  kind: 'complete',
  instruction: '',
})

export const createTransitionForm = (fromStep: string, toRef: string): RoutineTransitionForm => ({
  fromStep,
  toRef,
  guardKind: 'default',
  guardText: '',
  outcomeStatus: '',
  counterLimit: '',
  fieldRef: null,
  fieldOp: null,
  fieldValue: null,
  fieldValues: null,
  fieldUnit: null,
})

export const routineToForm = (routine: RoutineDefinition): RoutineFormState => {
  const transitionsByStep = new Map<string, RoutineTransitionForm[]>()
  for (const transition of [...routine.transitions].sort((left, right) => left.ordinal - right.ordinal)) {
    const forms = transitionsByStep.get(transition.fromStep) ?? []
    forms.push({
      fromStep: transition.fromStep,
      toRef: transition.toRef,
      guardKind: normalizeGuardKind(transition.guardKind as LegacyRoutineGuardKind),
      guardText: transition.guardText ?? '',
      outcomeStatus: transition.outcomeStatus ?? '',
      counterLimit: transition.counterLimit ? String(transition.counterLimit) : '',
      fieldRef: transition.fieldRef ?? null,
      fieldOp: transition.fieldOp ?? null,
      fieldValue: transition.fieldValue ?? null,
      fieldValues: transition.fieldValues ?? null,
      fieldUnit: transition.fieldUnit ?? null,
    })
    transitionsByStep.set(transition.fromStep, forms)
  }

  return {
    name: routine.name,
    activation: {
      triggerDescription: routine.activation.triggerDescription,
      priority: String(routine.activation.priority),
      reentryMode: routine.activation.reentryMode ?? 'once_per_conversation',
    },
    slots: [...routine.slots].sort((left, right) => left.ordinal - right.ordinal).map((slot) => ({
      stableSlotId: slot.stableSlotId,
      key: slot.key,
      type: slot.type,
      required: slot.required,
      description: slot.description ?? '',
      mutable: slot.mutable ?? false,
    })),
    steps: [...routine.steps].sort((left, right) => left.ordinal - right.ordinal).map((step) => {
      const kind = normalizeStepKind(step.kind as LegacyRoutineStepKind)
      const base = {
        stableStepId: step.stableStepId,
        kind,
        instruction: step.instruction,
        toolRef: step.toolRef ?? '',
        actionType: step.actionType ?? '',
        captureKey: '',
        options: [] as RoutineApprovalOptionForm[],
        metadata: step.metadata ?? {},
        transitions: transitionsByStep.get(step.stableStepId) ?? [],
      }
      if (kind !== 'approval') return base
      // An approval step routes only through its option branches (deterministic field
      // guards), so recover each option's target rather than surfacing the synthesized
      // edges in the generic transitions editor.
      const targets = approvalOptionTargets(
        routine.transitions.filter((transition) => transition.fromStep === step.stableStepId),
      )
      return {
        ...base,
        transitions: [],
        captureKey: step.captureKey ?? '',
        options: (step.options ?? []).map((option) => ({
          id: option.id,
          label: option.label,
          description: option.description ?? '',
          target: targets.get(option.id) ?? '',
        })),
      }
    }),
    terminals: [...routine.terminals].sort((left, right) => left.ordinal - right.ordinal).map((terminal) => ({
      stableStepId: terminal.stableStepId,
      kind: terminal.kind,
      instruction: terminal.instruction ?? '',
    })),
    completionExport: {
      enabled: routine.completionExport?.enabled ?? false,
      triggerKinds: routine.completionExport?.triggerKinds?.length
        ? [...routine.completionExport.triggerKinds]
        : ['complete'],
      destinationRef: routine.completionExport?.destinationRef ?? '',
    },
  }
}

export const formToRoutineDraft = (
  form: RoutineFormState,
  options: { header?: RoutineDraftHeader } = {},
): RoutineDefinitionDraft => {
  const header = options.header ?? form
  let transitionOrdinal = 0
  const completionExport: RoutineCompletionExport | undefined = form.completionExport.enabled
    ? {
        enabled: true,
        triggerKinds: form.completionExport.triggerKinds.length > 0
          ? form.completionExport.triggerKinds
          : ['complete'],
        destinationRef: form.completionExport.destinationRef.trim(),
      }
    : undefined

  return {
    name: header.name.trim(),
    activation: {
      triggerDescription: header.activation.triggerDescription.trim(),
      priority: Number.parseInt(header.activation.priority, 10) || 0,
      reentryMode: header.activation.reentryMode,
    },
    slots: form.slots.map((slot, index) => {
      const key = draftSlotKey(slot, index)
      return {
        stableSlotId: slugify(slot.stableSlotId || key, `slot_${index + 1}`),
        key,
        type: slot.type,
        required: slot.required,
        description: nullableText(slot.description),
        ordinal: index,
        ...(slot.mutable ? { mutable: true } : {}),
      }
    }),
    steps: form.steps.map((step, index) => ({
      stableStepId: draftStepId(step, index),
      kind: step.kind,
      instruction: step.instruction.trim(),
      toolRef: step.kind === 'tool' ? nullableText(step.toolRef) : null,
      ...(step.kind === 'action' ? { actionType: nullableText(step.actionType) } : {}),
      ...(step.kind === 'approval'
        ? {
            captureKey: step.captureKey.trim() ? slugifySlotKey(step.captureKey, step.captureKey) : null,
            options: step.options.map((option, optionIndex) => {
              const description = nullableText(option.description)
              return {
                id: slugify(option.id, `option_${optionIndex + 1}`),
                label: option.label.trim(),
                ...(description ? { description } : {}),
              }
            }),
          }
        : {}),
      ordinal: index,
      metadata: step.metadata ?? {},
    })),
    transitions: form.steps.flatMap((step, index) => {
      if (step.kind === 'approval') {
        // Approval option branches are deterministic field guards synthesized from the
        // per-option targets; the generic transitions array is unused for these steps.
        const captureKey = step.captureKey.trim() ? slugifySlotKey(step.captureKey, step.captureKey) : ''
        if (!captureKey) return []
        const fromStep = draftStepId(step, index)
        const branches = step.options
          .map((option, optionIndex) => ({
            optionId: slugify(option.id, `option_${optionIndex + 1}`),
            target: option.target.trim(),
          }))
          .filter((branch) => branch.target.length > 0)
          .map((branch) => ({ optionId: branch.optionId, target: draftTransitionTargetRef(branch.target) }))
        return approvalOptionTransitions(fromStep, captureKey, branches, () => transitionOrdinal++)
      }
      return step.transitions.map((transition) => ({
        fromStep: slugify(transition.fromStep || step.stableStepId, step.stableStepId),
        toRef: draftTransitionTargetRef(transition.toRef),
        guardKind: transition.guardKind,
        guardText: nullableText(transition.guardText),
        outcomeStatus: transition.guardKind === 'outcome' ? nullableText(transition.outcomeStatus) : null,
        counterLimit: transition.guardKind === 'counter'
          ? Number.parseInt(transition.counterLimit, 10) || null
          : null,
        fieldRef: transition.guardKind === 'field' ? transition.fieldRef : null,
        fieldOp: transition.guardKind === 'field' ? transition.fieldOp : null,
        fieldValue: transition.guardKind === 'field' ? transition.fieldValue : null,
        fieldValues: transition.guardKind === 'field' ? transition.fieldValues : null,
        fieldUnit: transition.guardKind === 'field' ? transition.fieldUnit : null,
        ordinal: transitionOrdinal++,
      }))
    }),
    terminals: form.terminals.map((terminal, index) => ({
      stableStepId: draftTerminalId(terminal, index),
      kind: terminal.kind,
      instruction: nullableText(terminal.instruction),
      ordinal: index,
    })),
    ...(completionExport ? { completionExport } : {}),
  }
}

export const buildCompletionExportPayloadPreview = (form: RoutineFormState): Record<string, unknown> => ({
  destinationRef: form.completionExport.destinationRef,
  source: {
    routineId: '<routine-id>',
    stepId: '<terminal-step-id>',
    terminalKind: form.completionExport.triggerKinds[0] ?? 'complete',
    status: 'completed',
  },
  data: Object.fromEntries(
    form.slots
      .map((slot) => [slot.key.trim(), `<${slot.type}>`] as const)
      .filter(([key]) => key.length > 0),
  ),
})

// The diagnostic `location` grammar, produced by backend `modules/routines/validator.ts`
// and `modules/routines/service.ts`:
//
//   node:<nodeId>                                a step or terminal (id collision)
//   step:<nodeId>                                a step or terminal
//   step:<nodeId>.inputBindings.<inputKey>       a field of a step
//   step:<nodeId>.outputAssignments.<outputKey>  a field of a step
//   transition:<fromStepId>-><toRef>             a declared edge
//   slot:<slotKey>                               a slot, declared or merely referenced
//   routine:<routineName>                        the routine itself (a NAME, not an id)
//   completionExport.destinationRef              a field of the routine
//
// `terminal:` is never produced; terminals live in the step id namespace.
// The backend parses the same grammar in `config-analysis/routineDiagnosticSubjects.ts`.
const NODE_PREFIX = 'node:'
const STEP_PREFIX = 'step:'
const SLOT_PREFIX = 'slot:'
const TRANSITION_PREFIX = 'transition:'
const ROUTINE_PREFIX = 'routine:'
const COMPLETION_EXPORT_PREFIX = 'completionExport.'
const STEP_FIELD_MARKERS = ['.inputBindings.', '.outputAssignments.'] as const

// Node ids may contain `.` and `-`, so a field location cannot be split at its first dot.
// With the declared ids to hand, resolve by membership longest-first (what the backend
// parser does); without them, strip a trailing field segment structurally. Either way a
// field diagnostic resolves to the step that declares the field, because that is the
// artifact the editor renders.
const resolveNodeId = (candidate: string, knownNodeIds?: ReadonlySet<string>): string => {
  if (knownNodeIds) {
    let remaining = candidate
    while (remaining.length > 0) {
      if (knownNodeIds.has(remaining)) return remaining
      const lastDot = remaining.lastIndexOf('.')
      if (lastDot < 0) break
      remaining = remaining.slice(0, lastDot)
    }
  }
  const fieldStart = STEP_FIELD_MARKERS.reduce(
    (found, marker) => Math.max(found, candidate.lastIndexOf(marker)),
    -1,
  )
  return fieldStart > 0 ? candidate.slice(0, fieldStart) : candidate
}

// Splits `<fromStepId>-><toRef>`. `>` is outside the id charset, so the sole `>` marks the
// separator — which `indexOf('->')` would get wrong for a step id containing `->`.
const parseEdgeId = (rest: string): string | null => {
  const arrowEnd = rest.indexOf('>')
  return arrowEnd > 0 && rest[arrowEnd - 1] === '-' ? rest : null
}

// Resolves a diagnostic to the artifact the editor should render it against. Anything the
// grammar does not cover resolves to the routine, which is always rendered, so a diagnostic
// can never be silently dropped.
export const diagnosticTargetFor = (
  diagnostic: RoutineValidationDiagnostic,
  knownNodeIds?: ReadonlySet<string>,
): DiagnosticTarget => {
  const location = diagnostic.location
  const routineTarget: DiagnosticTarget = { scope: 'routine', id: location }

  if (location.startsWith(SLOT_PREFIX)) {
    const key = location.slice(SLOT_PREFIX.length)
    return key.length > 0 ? { scope: 'slot', id: key } : routineTarget
  }

  if (location.startsWith(TRANSITION_PREFIX)) {
    const edgeId = parseEdgeId(location.slice(TRANSITION_PREFIX.length))
    return edgeId === null ? routineTarget : { scope: 'transition', id: edgeId }
  }

  if (location.startsWith(NODE_PREFIX) || location.startsWith(STEP_PREFIX)) {
    const prefixLength = location.startsWith(NODE_PREFIX) ? NODE_PREFIX.length : STEP_PREFIX.length
    const nodeId = resolveNodeId(location.slice(prefixLength), knownNodeIds)
    return nodeId.length > 0 ? { scope: 'step', id: nodeId } : routineTarget
  }

  if (location.startsWith(COMPLETION_EXPORT_PREFIX)) {
    const field = location.slice(COMPLETION_EXPORT_PREFIX.length)
    return field.length > 0 ? { scope: 'completionExport', id: field } : routineTarget
  }

  if (location.startsWith(ROUTINE_PREFIX)) {
    const name = location.slice(ROUTINE_PREFIX.length)
    return name.length > 0 ? { scope: 'routine', id: name } : routineTarget
  }

  return routineTarget
}

export const diagnosticsForTarget = (
  diagnostics: RoutineValidationDiagnostic[],
  target: DiagnosticTarget,
  knownNodeIds?: ReadonlySet<string>,
): RoutineValidationDiagnostic[] =>
  diagnostics.filter((diagnostic) => {
    const mapped = diagnosticTargetFor(diagnostic, knownNodeIds)
    return mapped.scope === target.scope && mapped.id === target.id
  })

// Every target the Form editor actually renders a diagnostic list against, in draft space.
// Kept beside the editor's anchors so "can this diagnostic be seen?" is answerable without
// rendering the tree.
export const renderedDiagnosticTargets = (form: RoutineFormState): DiagnosticTarget[] => {
  const targets: DiagnosticTarget[] = [
    ...form.slots.map((slot, index): DiagnosticTarget => ({ scope: 'slot', id: draftSlotKey(slot, index) })),
    ...form.steps.map((step, index): DiagnosticTarget => ({ scope: 'step', id: draftStepId(step, index) })),
    ...form.terminals.map((terminal, index): DiagnosticTarget => ({ scope: 'step', id: draftTerminalId(terminal, index) })),
  ]
  form.steps.forEach((step, stepIndex) => {
    if (step.kind === 'approval') {
      for (const option of step.options) {
        const id = draftApprovalOptionTransitionId(step, stepIndex, option)
        if (id) targets.push({ scope: 'transition', id })
      }
      return
    }
    for (const transition of step.transitions) {
      targets.push({ scope: 'transition', id: draftTransitionId(step, transition) })
    }
  })
  if (form.completionExport.enabled) {
    targets.push({ scope: 'completionExport', id: 'destinationRef' })
  }
  return targets
}

const targetKey = (target: DiagnosticTarget): string => `${target.scope} ${target.id}`

// FR-030 backstop: the diagnostics that belong at routine level are the genuinely
// routine-scoped ones *plus* every diagnostic whose target no rendered artifact claims —
// including all of them when the Form editor is not on screen at all (prose mode), where
// `renderedTargets` is empty. Nothing the validator emits can be invisible.
export const routineLevelDiagnostics = (
  diagnostics: RoutineValidationDiagnostic[],
  renderedTargets: readonly DiagnosticTarget[],
): RoutineValidationDiagnostic[] => {
  const rendered = new Set(renderedTargets.map(targetKey))
  const knownNodeIds = new Set(
    renderedTargets.filter((target) => target.scope === 'step').map((target) => target.id),
  )
  return diagnostics.filter((diagnostic) => {
    const target = diagnosticTargetFor(diagnostic, knownNodeIds)
    return target.scope === 'routine' || !rendered.has(targetKey(target))
  })
}
