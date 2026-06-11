import type {
  RoutineDefinition,
  RoutineDefinitionDraft,
  RoutineGuardKind,
  RoutineSlotType,
  RoutineStepKind,
  RoutineTerminalKind,
  RoutineValidationDiagnostic,
} from './api-types'

export type RoutineOutlineActionOption = {
  ref: string
  label: string
  kind: Extract<RoutineStepKind, 'tool' | 'action'>
  outcomeStatuses?: string[]
}

export type RoutineOutlineVariable = {
  stableSlotId: string
  key: string
  type: RoutineSlotType
  required: boolean
  description: string
}

export type RoutineOutlineBranch = {
  id: string
  condition: string
  targetRef: string
  outcomeStatus: string
  counterLimit: string
}

export type RoutineOutlineStep = {
  stableStepId: string
  label: string
  instruction: string
  branches: RoutineOutlineBranch[]
}

export type RoutineOutlineEnd = {
  stableStepId: string
  label: string
  message: string
  handoff: boolean
}

export type RoutineOutlineState = {
  name: string
  activation: {
    triggerDescription: string
    priority: string
  }
  variables: RoutineOutlineVariable[]
  steps: RoutineOutlineStep[]
  ends: RoutineOutlineEnd[]
}

export type RoutineDraftHeader = Pick<RoutineOutlineState, 'name' | 'activation'>

export type OutlineDiagnosticTarget = {
  scope: 'routine' | 'variable' | 'step' | 'branch' | 'end'
  id: string
}

type RoutineDraftLike = RoutineDefinitionDraft | RoutineDefinition
type LegacyRoutineGuardKind = RoutineGuardKind | 'always' | 'fallback'

const ACTION_TOKEN_PATTERN = /\{\{\s*action\.([^}]+?)\s*\}\}/gu

const slugify = (value: string, fallback: string): string => {
  const slug = value.trim().replace(/[^A-Za-z0-9_.-]+/gu, '_').replace(/^([^A-Za-z_])/u, '_$1')
  return slug.length > 0 ? slug : fallback
}

const slotKey = (value: string, fallback: string): string =>
  slugify(value, fallback).replace(/[^A-Za-z0-9_]/gu, '_')

const nullableText = (value: string): string | null => {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const normalizeGuardKind = (kind: LegacyRoutineGuardKind): RoutineGuardKind =>
  kind === 'always' || kind === 'fallback' ? 'default' : kind

const actionToken = (ref: string): string => `{{action.${ref}}}`

const variableTokenToMention = (value: string): string =>
  value.replace(/\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu, '@$1')

const variableMentionToToken = (value: string, variableKeys: Set<string>): string =>
  value.replace(/@([A-Za-z_][A-Za-z0-9_]*)\b/gu, (match, key: string) =>
    variableKeys.has(key) ? `{{slot.${key}}}` : match,
  )

const actionTokenToMention = (value: string, options: RoutineOutlineActionOption[]): string =>
  value.replace(ACTION_TOKEN_PATTERN, (_match, ref: string) => {
    const option = options.find((candidate) => candidate.ref === ref.trim())
    return `@${option?.label ?? ref.trim()}`
  })

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const actionMentionToToken = (value: string, options: RoutineOutlineActionOption[]): string => {
  let next = value
  for (const option of options) {
    const pattern = new RegExp(`@${escapeRegExp(option.label)}\\b`, 'gu')
    next = next.replace(pattern, actionToken(option.ref))
  }
  return next
}

const displayInstruction = (value: string, options: RoutineOutlineActionOption[]): string =>
  actionTokenToMention(variableTokenToMention(value), options)

const displayStepInstruction = (
  step: RoutineDraftLike['steps'][number],
  options: RoutineOutlineActionOption[],
): string => {
  const displayed = displayInstruction(step.instruction, options)
  const ref = step.kind === 'tool' ? step.toolRef : step.kind === 'action' ? step.actionType : null
  const option = ref ? options.find((candidate) => candidate.ref === ref) : null
  if (!option || displayed.includes(`@${option.label}`)) return displayed
  return `${displayed} @${option.label}`.trim()
}

const storedInstruction = (
  value: string,
  variableKeys: Set<string>,
  options: RoutineOutlineActionOption[],
): string =>
  variableMentionToToken(actionMentionToToken(value, options), variableKeys).trim()

const stepLabel = (step: RoutineDraftLike['steps'][number]): string => {
  const label = step.metadata?.outlineLabel
  return typeof label === 'string' && label.trim().length > 0 ? label : step.stableStepId
}

const branchGuardKind = (branch: RoutineOutlineBranch): RoutineGuardKind => {
  if (branch.counterLimit.trim()) return 'counter'
  if (branch.outcomeStatus.trim()) return 'outcome'
  if (branch.condition.trim()) return 'llm'
  return 'default'
}

const actionForInstruction = (
  instruction: string,
  options: RoutineOutlineActionOption[],
): RoutineOutlineActionOption | null => {
  for (const match of instruction.matchAll(ACTION_TOKEN_PATTERN)) {
    const ref = match[1]?.trim()
    const option = options.find((candidate) => candidate.ref === ref)
    if (option) return option
  }
  for (const option of options) {
    if (instruction.includes(`@${option.label}`)) return option
  }
  return null
}

export const createEmptyRoutineOutline = (): RoutineOutlineState => ({
  name: '',
  activation: {
    triggerDescription: '',
    priority: '0',
  },
  variables: [],
  steps: [{
    stableStepId: 'step_1',
    label: 'Step 1',
    instruction: '',
    branches: [],
  }],
  ends: [{
    stableStepId: 'complete',
    label: 'Complete',
    message: '',
    handoff: false,
  }],
})

export const createOutlineVariable = (index: number): RoutineOutlineVariable => ({
  stableSlotId: `slot_${index + 1}`,
  key: `slot_${index + 1}`,
  type: 'text',
  required: true,
  description: '',
})

export const createOutlineStep = (index: number): RoutineOutlineStep => ({
  stableStepId: `step_${index + 1}`,
  label: `Step ${index + 1}`,
  instruction: '',
  branches: [],
})

export const createOutlineEnd = (index: number): RoutineOutlineEnd => ({
  stableStepId: `complete_${index + 1}`,
  label: `End ${index + 1}`,
  message: '',
  handoff: false,
})

export const createOutlineBranch = (fromStepId: string, index: number, targetRef: string): RoutineOutlineBranch => ({
  id: `${fromStepId}:${index}`,
  condition: '',
  targetRef,
  outcomeStatus: '',
  counterLimit: '',
})

export const routineDraftToOutline = (
  draft: RoutineDraftLike,
  options: { actionOptions?: RoutineOutlineActionOption[] } = {},
): RoutineOutlineState => {
  const actionOptions = options.actionOptions ?? []
  const transitionsByStep = new Map<string, RoutineOutlineBranch[]>()
  for (const transition of [...draft.transitions].sort((left, right) => left.ordinal - right.ordinal)) {
    const guardKind = normalizeGuardKind(transition.guardKind as LegacyRoutineGuardKind)
    const branches = transitionsByStep.get(transition.fromStep) ?? []
    branches.push({
      id: `${transition.fromStep}:${branches.length}`,
      condition: guardKind === 'llm' || guardKind === 'counter' ? transition.guardText ?? '' : '',
      targetRef: transition.toRef,
      outcomeStatus: guardKind === 'outcome' ? transition.outcomeStatus ?? '' : '',
      counterLimit: guardKind === 'counter' && transition.counterLimit ? String(transition.counterLimit) : '',
    })
    transitionsByStep.set(transition.fromStep, branches)
  }

  return {
    name: draft.name,
    activation: {
      triggerDescription: draft.activation.triggerDescription,
      priority: String(draft.activation.priority),
    },
    variables: [...draft.slots].sort((left, right) => left.ordinal - right.ordinal).map((slot) => ({
      stableSlotId: slot.stableSlotId,
      key: slot.key,
      type: slot.type,
      required: slot.required,
      description: slot.description ?? '',
    })),
    steps: [...draft.steps].sort((left, right) => left.ordinal - right.ordinal).map((step) => ({
      stableStepId: step.stableStepId,
      label: stepLabel(step),
      instruction: displayStepInstruction(step, actionOptions),
      branches: transitionsByStep.get(step.stableStepId) ?? [],
    })),
    ends: [...draft.terminals].sort((left, right) => left.ordinal - right.ordinal).map((terminal) => ({
      stableStepId: terminal.stableStepId,
      label: terminal.stableStepId,
      message: terminal.instruction ?? '',
      handoff: terminal.kind === 'handoff',
    })),
  }
}

export const routineDraftProposalToOutline = (
  draft: RoutineDefinitionDraft,
  options: { actionOptions?: RoutineOutlineActionOption[] } = {},
): RoutineOutlineState => routineDraftToOutline(draft, options)

export const outlineToRoutineDraft = (
  outline: RoutineOutlineState,
  options: { actionOptions?: RoutineOutlineActionOption[]; header?: RoutineDraftHeader } = {},
): RoutineDefinitionDraft => {
  const actionOptions = options.actionOptions ?? []
  const header = options.header ?? outline
  const variableKeys = new Set(outline.variables.map((variable, index) => slotKey(variable.key, `slot_${index + 1}`)))
  let transitionOrdinal = 0
  return {
    name: header.name.trim(),
    activation: {
      triggerDescription: header.activation.triggerDescription.trim(),
      priority: Number.parseInt(header.activation.priority, 10) || 0,
    },
    slots: outline.variables.map((variable, index) => {
      const key = slotKey(variable.key, `slot_${index + 1}`)
      return {
        stableSlotId: slugify(variable.stableSlotId || key, `slot_${index + 1}`),
        key,
        type: variable.type,
        required: variable.required,
        description: nullableText(variable.description),
        ordinal: index,
      }
    }),
    steps: outline.steps.map((step, index) => {
      const stableStepId = slugify(step.stableStepId || step.label, `step_${index + 1}`)
      const instruction = storedInstruction(step.instruction, variableKeys, actionOptions)
      const action = actionForInstruction(instruction, actionOptions)
      const kind = action?.kind ?? 'chat'
      return {
        stableStepId,
        kind,
        instruction,
        toolRef: kind === 'tool' && action ? action.ref : null,
        ...(kind === 'action' && action ? { actionType: action.ref } : {}),
        ordinal: index,
        metadata: {
          outlineLabel: step.label.trim() || stableStepId,
        },
      }
    }),
    transitions: outline.steps.flatMap((step) => {
      const fromStep = slugify(step.stableStepId || step.label, 'step_1')
      const supportsOutcome = actionForInstruction(storedInstruction(step.instruction, variableKeys, actionOptions), actionOptions) !== null
      return step.branches.map((branch) => {
        const branchForGuard = supportsOutcome ? branch : { ...branch, outcomeStatus: '' }
        const guardKind = branchGuardKind(branchForGuard)
        return {
          fromStep,
          toRef: slugify(branch.targetRef, 'complete'),
          guardKind,
          guardText: guardKind === 'llm' || guardKind === 'counter' ? nullableText(branchForGuard.condition) : null,
          outcomeStatus: guardKind === 'outcome' ? nullableText(branchForGuard.outcomeStatus) : null,
          counterLimit: guardKind === 'counter' ? Number.parseInt(branchForGuard.counterLimit, 10) || null : null,
          ordinal: transitionOrdinal++,
        }
      })
    }),
    terminals: outline.ends.map((end, index) => ({
      stableStepId: slugify(end.stableStepId || end.label, `complete_${index + 1}`),
      kind: (end.handoff ? 'handoff' : 'complete') satisfies RoutineTerminalKind,
      instruction: nullableText(end.message),
      ordinal: index,
    })),
  }
}

const targetForDiagnostic = (diagnostic: RoutineValidationDiagnostic): OutlineDiagnosticTarget => {
  const [scope, rest = ''] = diagnostic.location.split(':', 2)
  if (scope === 'slot') return { scope: 'variable', id: rest }
  if (scope === 'step') return { scope: 'step', id: rest }
  if (scope === 'terminal') return { scope: 'end', id: rest }
  if (scope === 'transition') return { scope: 'branch', id: rest }
  return { scope: 'routine', id: rest }
}

export const diagnosticsForOutlineTarget = (
  diagnostics: RoutineValidationDiagnostic[],
  target: OutlineDiagnosticTarget,
): RoutineValidationDiagnostic[] =>
  diagnostics.filter((diagnostic) => {
    const mapped = targetForDiagnostic(diagnostic)
    return mapped.scope === target.scope && mapped.id === target.id
  })
