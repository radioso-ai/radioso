import type {
  RoutineDefinition,
  RoutineDefinitionDraft,
  RoutineCompletionExport,
  RoutineGuardKind,
  RoutineReentryMode,
  RoutineSlotType,
  RoutineStepKind,
  RoutineTerminalKind,
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

export type DiagnosticTarget = {
  scope: 'routine' | 'slot' | 'step' | 'transition' | 'terminal'
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
      const key = slugify(slot.key, `slot_${index + 1}`).replace(/[^A-Za-z0-9_]/gu, '_')
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
      stableStepId: slugify(step.stableStepId, `step_${index + 1}`),
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
        const fromStep = slugify(step.stableStepId, `step_${index + 1}`)
        const branches = step.options
          .map((option, optionIndex) => ({
            optionId: slugify(option.id, `option_${optionIndex + 1}`),
            target: option.target.trim(),
          }))
          .filter((branch) => branch.target.length > 0)
          .map((branch) => ({ optionId: branch.optionId, target: slugify(branch.target, 'complete') }))
        return approvalOptionTransitions(fromStep, captureKey, branches, () => transitionOrdinal++)
      }
      return step.transitions.map((transition) => ({
        fromStep: slugify(transition.fromStep || step.stableStepId, step.stableStepId),
        toRef: slugify(transition.toRef, 'complete'),
        guardKind: transition.guardKind,
        guardText: nullableText(transition.guardText),
        outcomeStatus: transition.guardKind === 'outcome' ? nullableText(transition.outcomeStatus) : null,
        counterLimit: transition.guardKind === 'counter'
          ? Number.parseInt(transition.counterLimit, 10) || null
          : null,
        ordinal: transitionOrdinal++,
      }))
    }),
    terminals: form.terminals.map((terminal, index) => ({
      stableStepId: slugify(terminal.stableStepId, `complete_${index + 1}`),
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

export const diagnosticTargetFor = (diagnostic: RoutineValidationDiagnostic): DiagnosticTarget => {
  const [scope, rest = ''] = diagnostic.location.split(':', 2)
  if (scope === 'slot' || scope === 'step' || scope === 'terminal') {
    return { scope, id: rest }
  }
  if (scope === 'transition') {
    return { scope, id: rest }
  }
  return { scope: 'routine', id: rest }
}

export const diagnosticsForTarget = (
  diagnostics: RoutineValidationDiagnostic[],
  target: DiagnosticTarget,
): RoutineValidationDiagnostic[] =>
  diagnostics.filter((diagnostic) => {
    const mapped = diagnosticTargetFor(diagnostic)
    return mapped.scope === target.scope && mapped.id === target.id
  })
