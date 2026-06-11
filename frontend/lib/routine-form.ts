import type {
  RoutineDefinition,
  RoutineDefinitionDraft,
  RoutineCompletionExport,
  RoutineGuardKind,
  RoutineSlotType,
  RoutineStepKind,
  RoutineTerminalKind,
  RoutineValidationDiagnostic,
} from './api-types'

export type RoutineSlotForm = {
  stableSlotId: string
  key: string
  type: RoutineSlotType
  required: boolean
  description: string
}

export type RoutineTransitionForm = {
  fromStep: string
  toRef: string
  guardKind: RoutineGuardKind
  guardText: string
  outcomeStatus: string
  counterLimit: string
}

export type RoutineStepForm = {
  stableStepId: string
  kind: Exclude<RoutineStepKind, 'fork'>
  instruction: string
  toolRef: string
  actionType: string
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

export const createEmptyRoutineForm = (): RoutineFormState => ({
  name: '',
  activation: {
    triggerDescription: '',
    priority: '0',
  },
  slots: [],
  steps: [{
    stableStepId: 'step_1',
    kind: 'chat',
    instruction: '',
    toolRef: '',
    actionType: '',
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
})

export const createStepForm = (index: number): RoutineStepForm => ({
  stableStepId: `step_${index + 1}`,
  kind: 'chat',
  instruction: '',
  toolRef: '',
  actionType: '',
  transitions: [],
})

export const createTerminalForm = (index: number): RoutineTerminalForm => ({
  stableStepId: `complete_${index + 1}`,
  kind: 'complete',
  instruction: '',
})

export const createTransitionForm = (fromStep: string, toRef: string): RoutineTransitionForm => ({
  fromStep,
  toRef,
  guardKind: 'always',
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
      guardKind: transition.guardKind,
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
    },
    slots: [...routine.slots].sort((left, right) => left.ordinal - right.ordinal).map((slot) => ({
      stableSlotId: slot.stableSlotId,
      key: slot.key,
      type: slot.type,
      required: slot.required,
      description: slot.description ?? '',
    })),
    steps: [...routine.steps].sort((left, right) => left.ordinal - right.ordinal).map((step) => ({
      stableStepId: step.stableStepId,
      kind: step.kind === 'fork' ? 'chat' : step.kind,
      instruction: step.instruction,
      toolRef: step.toolRef ?? '',
      actionType: step.actionType ?? '',
      transitions: transitionsByStep.get(step.stableStepId) ?? [],
    })),
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

export const formToRoutineDraft = (form: RoutineFormState): RoutineDefinitionDraft => {
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
    name: form.name.trim(),
    activation: {
      triggerDescription: form.activation.triggerDescription.trim(),
      priority: Number.parseInt(form.activation.priority, 10) || 0,
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
      }
    }),
    steps: form.steps.map((step, index) => ({
      stableStepId: slugify(step.stableStepId, `step_${index + 1}`),
      kind: step.kind,
      instruction: step.instruction.trim(),
      toolRef: step.kind === 'tool' ? nullableText(step.toolRef) : null,
      ...(step.kind === 'action' ? { actionType: nullableText(step.actionType) } : {}),
      ordinal: index,
      metadata: {},
    })),
    transitions: form.steps.flatMap((step) =>
      step.transitions.map((transition) => ({
        fromStep: slugify(transition.fromStep || step.stableStepId, step.stableStepId),
        toRef: slugify(transition.toRef, 'complete'),
        guardKind: transition.guardKind,
        guardText: nullableText(transition.guardText),
        outcomeStatus: transition.guardKind === 'outcome' ? nullableText(transition.outcomeStatus) : null,
        counterLimit: transition.guardKind === 'counter'
          ? Number.parseInt(transition.counterLimit, 10) || null
          : null,
        ordinal: transitionOrdinal++,
      })),
    ),
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
