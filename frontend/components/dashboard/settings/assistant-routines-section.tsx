'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, CheckCircle2, FormInput, ListTree, Pencil, Plus, Route, Send, Trash2, Variable, Wrench } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  RoutinePublishRejectedError,
  routinesApi,
  type RoutineDefinition,
  type RoutineDefinitionDraft,
  type RoutineGuardKind,
  type RoutineSlotType,
  type RoutineTerminalKind,
  type RoutineValidationDiagnostic,
  type RoutineValidationResult,
} from '@/lib/api'
import {
  createSlotForm,
  createStepForm,
  createTerminalForm,
  createTransitionForm,
  diagnosticTargetFor,
  diagnosticsForTarget,
  formToRoutineDraft,
  routineToForm,
  type RoutineDraftHeader,
  type RoutineFormState,
} from '@/lib/routine-form'
import {
  createEmptyRoutineOutline,
  createOutlineBranch,
  createOutlineEnd,
  createOutlineStep,
  createOutlineVariable,
  diagnosticsForOutlineTarget,
  outlineToRoutineDraft,
  routineDraftToOutline,
  type RoutineOutlineActionOption,
  type RoutineOutlineState,
  type RoutineOutlineStep,
} from '@/lib/routine-outline'

const slotTypes: RoutineSlotType[] = ['text', 'number', 'boolean', 'email', 'date']
const guardKinds: RoutineGuardKind[] = ['llm', 'slot_filled', 'outcome', 'counter', 'default']
const stepKinds: Array<'chat' | 'action'> = ['chat', 'action']
const terminalKinds: RoutineTerminalKind[] = ['complete', 'handoff']
const outlineActionOptions: RoutineOutlineActionOption[] = [
  { ref: 'contact.send', label: 'Contact Send', kind: 'action' },
]

const optionLabel = (value: string) => value.replace(/_/gu, ' ')

const draftError = (draft: RoutineDefinitionDraft): string | null => {
  if (!draft.name.trim()) return 'Name is required.'
  if (!draft.activation.triggerDescription.trim()) return 'Activation trigger is required.'
  if (draft.steps.length === 0 || draft.steps.some((step) => !step.instruction.trim())) {
    return 'Each routine needs at least one step with an instruction.'
  }
  if (draft.terminals.length === 0) return 'At least one terminal is required.'
  if (draft.steps.some((step) => step.kind === 'tool' && !step.toolRef?.trim())) {
    return 'Tool steps need a tool reference.'
  }
  if (draft.steps.some((step) => step.kind === 'action' && !step.actionType?.trim())) {
    return 'Action steps need an action type.'
  }
  return null
}

const draftAsRoutine = (draft: RoutineDefinitionDraft, routine?: RoutineDefinition | null): RoutineDefinition => ({
  ...draft,
  id: routine?.id ?? 'local-draft',
  agentId: routine?.agentId ?? 'local-agent',
  version: routine?.version ?? 1,
  status: routine?.status ?? 'draft',
  createdAt: routine?.createdAt ?? new Date(0).toISOString(),
  updatedAt: routine?.updatedAt ?? new Date(0).toISOString(),
})

const headerFromDraft = (draft: RoutineDefinitionDraft | RoutineDefinition | RoutineOutlineState | RoutineFormState): RoutineDraftHeader => ({
  name: draft.name,
  activation: {
    triggerDescription: draft.activation.triggerDescription,
    priority: String(draft.activation.priority),
  },
})

const actionForOutlineStep = (step: RoutineOutlineStep): RoutineOutlineActionOption | null =>
  outlineActionOptions.find((option) =>
    step.instruction.includes(`@${option.label}`) || step.instruction.includes(`{{action.${option.ref}}}`),
  ) ?? null

function DiagnosticList({ diagnostics }: { diagnostics: RoutineValidationDiagnostic[] }) {
  if (diagnostics.length === 0) return null
  return (
    <div className="space-y-1" role="status">
      {diagnostics.map((diagnostic) => (
        <p key={`${diagnostic.location}-${diagnostic.code}`} className="text-xs text-destructive">
          {diagnostic.message}
        </p>
      ))}
    </div>
  )
}

function VariableInsertButton({
  slotKeys,
  ariaLabel = 'Insert variable',
  onInsert,
}: {
  slotKeys: string[]
  ariaLabel?: string
  onInsert: (token: string) => void
}) {
  if (slotKeys.length === 0) return null
  return (
    <Select onValueChange={(key) => onInsert(`{{slot.${key}}}`)}>
      <SelectTrigger aria-label={ariaLabel} className="h-8 w-[160px]">
        <Variable className="mr-2 h-4 w-4" />
        <SelectValue placeholder="Insert variable" />
      </SelectTrigger>
      <SelectContent>
        {slotKeys.map((key) => (
          <SelectItem key={key} value={key}>{key}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function AssistantRoutinesSection({
  agentId,
  onSaveStateChange,
}: {
  agentId: string
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  const [routines, setRoutines] = useState<RoutineDefinition[]>([])
  const [editingRoutineId, setEditingRoutineId] = useState<string | null>(null)
  const [form, setForm] = useState<RoutineFormState | null>(null)
  const [outline, setOutline] = useState<RoutineOutlineState | null>(null)
  const [draftHeader, setDraftHeader] = useState<RoutineDraftHeader>(() => headerFromDraft(createEmptyRoutineOutline()))
  const [viewMode, setViewMode] = useState<'outline' | 'form'>('outline')
  const [validation, setValidation] = useState<RoutineValidationResult | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const instructionRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const outlineInstructionRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const { beginSave, isCurrentSave, markError, markSaved } = useSettingsSaveStatus(onSaveStateChange)

  const sortedRoutines = useMemo(
    () => [...routines].sort((left, right) => left.name.localeCompare(right.name) || left.version - right.version),
    [routines],
  )
  const editingRoutine = useMemo(
    () => routines.find((routine) => routine.id === editingRoutineId) ?? null,
    [editingRoutineId, routines],
  )
  const slotKeys = useMemo(
    () => viewMode === 'outline'
      ? outline?.variables.map((slot) => slot.key.trim()).filter(Boolean) ?? []
      : form?.slots.map((slot) => slot.key.trim()).filter(Boolean) ?? [],
    [form, outline, viewMode],
  )
  const routineDiagnostics = useMemo(
    () => (validation?.diagnostics ?? []).filter((diagnostic) => diagnosticTargetFor(diagnostic).scope === 'routine'),
    [validation],
  )

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setIsLoading(true)
      setError(null)
      void routinesApi.listRoutines(agentId)
        .then((response) => {
          if (!active) return
          setRoutines(response.routines)
        })
        .catch((loadError) => {
          if (!active) return
          setError(getApiErrorMessage(loadError, 'Failed to load routines.'))
        })
        .finally(() => {
          if (active) setIsLoading(false)
        })
    })
    return () => {
      active = false
    }
  }, [agentId])

  const mergeRoutine = (routine: RoutineDefinition, removeRoutineId?: string) => {
    setRoutines((current) => {
      const without = current.filter((item) => item.id !== routine.id && item.id !== removeRoutineId)
      return [...without, routine]
    })
  }

  const startCreate = () => {
    setEditingRoutineId(null)
    const nextOutline = createEmptyRoutineOutline()
    const nextHeader = headerFromDraft(nextOutline)
    setDraftHeader(nextHeader)
    setOutline(nextOutline)
    setForm(routineToForm(draftAsRoutine(outlineToRoutineDraft(nextOutline, { actionOptions: outlineActionOptions, header: nextHeader }))))
    setViewMode('outline')
    setValidation(null)
    setError(null)
  }

  const startEdit = (routine: RoutineDefinition) => {
    setEditingRoutineId(routine.id)
    setDraftHeader(headerFromDraft(routine))
    setForm(routineToForm(routine))
    setOutline(routineDraftToOutline(routine, { actionOptions: outlineActionOptions }))
    setViewMode('outline')
    setValidation(null)
    setError(null)
  }

  const activeDraft = (): RoutineDefinitionDraft | null => {
    if (viewMode === 'outline') {
      return outline ? outlineToRoutineDraft(outline, { actionOptions: outlineActionOptions, header: draftHeader }) : null
    }
    return form ? formToRoutineDraft(form, { header: draftHeader }) : null
  }

  const synchronizeView = (nextView: 'outline' | 'form') => {
    if (nextView === viewMode) return
    if (nextView === 'outline' && form) {
      setOutline(routineDraftToOutline(formToRoutineDraft(form, { header: draftHeader }), { actionOptions: outlineActionOptions }))
    }
    if (nextView === 'form' && outline) {
      setForm(routineToForm(draftAsRoutine(outlineToRoutineDraft(outline, { actionOptions: outlineActionOptions, header: draftHeader }), editingRoutine)))
    }
    setViewMode(nextView)
  }

  const saveDraft = async (): Promise<RoutineDefinition | null> => {
    const draft = activeDraft()
    if (!draft) return null
    const errorMessage = draftError(draft)
    if (errorMessage) {
      setError(errorMessage)
      return null
    }
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    try {
      const response = editingRoutineId
        ? await routinesApi.updateRoutine(agentId, editingRoutineId, draft)
        : await routinesApi.createRoutine(agentId, draft)
      if (!isCurrentSave(saveId)) return null
      mergeRoutine(response.routine)
      setEditingRoutineId(response.routine.id)
      setDraftHeader(headerFromDraft(response.routine))
      setForm(routineToForm(response.routine))
      setOutline(routineDraftToOutline(response.routine, { actionOptions: outlineActionOptions }))
      setValidation(response.validation)
      markSaved()
      return response.routine
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return null
      const message = getApiErrorMessage(saveError, 'Failed to save routine draft.')
      setError(message)
      markError(message)
      return null
    } finally {
      if (isCurrentSave(saveId)) setIsSaving(false)
    }
  }

  const validateDraft = async () => {
    const routine = await saveDraft()
    if (!routine) return
    setIsSaving(true)
    setError(null)
    try {
      const response = await routinesApi.validateRoutine(agentId, routine.id)
      setValidation(response.validation)
    } catch (validateError) {
      setError(getApiErrorMessage(validateError, 'Failed to validate routine.'))
    } finally {
      setIsSaving(false)
    }
  }

  const publishDraft = async () => {
    const routine = editingRoutineId ? await saveDraft() : await saveDraft()
    if (!routine) return
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    try {
      const response = await routinesApi.publishRoutine(agentId, routine.id)
      if (!isCurrentSave(saveId)) return
      mergeRoutine(response.routine, routine.id)
      setEditingRoutineId(response.routine.id)
      setValidation(response.validation)
      markSaved()
    } catch (publishError) {
      if (!isCurrentSave(saveId)) return
      if (publishError instanceof RoutinePublishRejectedError) {
        setValidation(publishError.response.validation)
        setError('Routine is not ready to publish.')
        markError('Routine is not ready to publish.')
      } else {
        const message = getApiErrorMessage(publishError, 'Failed to publish routine.')
        setError(message)
        markError(message)
      }
    } finally {
      if (isCurrentSave(saveId)) setIsSaving(false)
    }
  }

  const deleteDraft = async (routine: RoutineDefinition) => {
    if (routine.status !== 'draft') return
    setIsSaving(true)
    setError(null)
    try {
      await routinesApi.deleteRoutine(agentId, routine.id)
      setRoutines((current) => current.filter((item) => item.id !== routine.id))
      if (editingRoutineId === routine.id) {
        setEditingRoutineId(null)
        setForm(null)
        setOutline(null)
        setDraftHeader(headerFromDraft(createEmptyRoutineOutline()))
      }
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete routine draft.'))
    } finally {
      setIsSaving(false)
    }
  }

  const updateForm = (updater: (current: RoutineFormState) => RoutineFormState) => {
    setForm((current) => current ? updater(current) : current)
  }

  const updateOutline = (updater: (current: RoutineOutlineState) => RoutineOutlineState) => {
    setOutline((current) => current ? updater(current) : current)
  }

  const insertVariable = (stepId: string, token: string) => {
    const textarea = instructionRefs.current[stepId]
    updateForm((current) => ({
      ...current,
      steps: current.steps.map((step) => {
        if (step.stableStepId !== stepId) return step
        const start = textarea?.selectionStart ?? step.instruction.length
        const end = textarea?.selectionEnd ?? step.instruction.length
        return {
          ...step,
          instruction: `${step.instruction.slice(0, start)}${token}${step.instruction.slice(end)}`,
        }
      }),
    }))
  }

  const insertOutlineToken = (stepId: string, token: string) => {
    const textarea = outlineInstructionRefs.current[stepId]
    updateOutline((current) => ({
      ...current,
      steps: current.steps.map((step) => {
        if (step.stableStepId !== stepId) return step
        const start = textarea?.selectionStart ?? step.instruction.length
        const end = textarea?.selectionEnd ?? step.instruction.length
        return {
          ...step,
          instruction: `${step.instruction.slice(0, start)}${token}${step.instruction.slice(end)}`,
        }
      }),
    }))
  }

  return (
    <SettingsCard
      id="assistant-routines-card"
      icon={<Route className="h-5 w-5 text-primary" />}
      title="Routines"
      description="Structured multi-step routines this agent can validate and publish."
      headerEnd={(
        <Button type="button" size="sm" onClick={startCreate}>
          <Plus className="mr-2 h-4 w-4" />
          New routine
        </Button>
      )}
    >
      <div className="space-y-6">
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading routines...
          </div>
        ) : sortedRoutines.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No routines yet.
          </p>
        ) : (
          <div className="space-y-3">
            {sortedRoutines.map((routine) => (
              <div key={routine.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{routine.name}</p>
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {routine.status}
                    </span>
                    <span className="text-xs text-muted-foreground">v{routine.version}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{routine.activation.triggerDescription}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {routine.status === 'draft' ? (
                    <>
                      <Button type="button" variant="ghost" size="sm" onClick={() => startEdit(routine)} aria-label={`Edit draft ${routine.name}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => void deleteDraft(routine)} aria-label={`Delete draft ${routine.name}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  ) : (
                    <Button type="button" variant="ghost" size="sm" onClick={() => startEdit(routine)} aria-label={`View ${routine.name}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {form ? (
          <div className="space-y-5 rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  {editingRoutine ? `Edit ${editingRoutine.name}` : 'Create routine'}
                </h3>
                {editingRoutine ? (
                  <p className="text-xs text-muted-foreground">{editingRoutine.status} v{editingRoutine.version}</p>
                ) : null}
              </div>
              {validation?.ok ? (
                <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Validation passed
                </p>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
              <div className="space-y-1">
                <Label htmlFor="routineName">Name</Label>
                <Input
                  id="routineName"
                  value={draftHeader.name}
                  onChange={(event) => setDraftHeader((current) => ({ ...current, name: event.target.value }))}
                  disabled={editingRoutine?.status === 'published'}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="routinePriority">Priority</Label>
                <Input
                  id="routinePriority"
                  type="number"
                  value={draftHeader.activation.priority}
                  onChange={(event) => setDraftHeader((current) => ({
                    ...current,
                    activation: { ...current.activation, priority: event.target.value },
                  }))}
                  disabled={editingRoutine?.status === 'published'}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="routineTrigger">Activation trigger</Label>
                <Textarea
                  id="routineTrigger"
                  value={draftHeader.activation.triggerDescription}
                  onChange={(event) => setDraftHeader((current) => ({
                    ...current,
                    activation: { ...current.activation, triggerDescription: event.target.value },
                  }))}
                  rows={2}
                  disabled={editingRoutine?.status === 'published'}
                />
              </div>
            </div>
            <DiagnosticList diagnostics={routineDiagnostics} />

            <Tabs value={viewMode} onValueChange={(value) => synchronizeView(value as 'outline' | 'form')}>
              <TabsList aria-label="Routine editor view">
                <TabsTrigger value="outline">
                  <ListTree className="h-4 w-4" />
                  Outline
                </TabsTrigger>
                <TabsTrigger value="form">
                  <FormInput className="h-4 w-4" />
                  Form
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {viewMode === 'outline' && outline ? (
              <>
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h4 className="text-sm font-semibold text-foreground">Variables</h4>
                    <Button type="button" size="sm" variant="outline" disabled={editingRoutine?.status === 'published'} onClick={() => updateOutline((current) => ({
                      ...current,
                      variables: [...current.variables, createOutlineVariable(current.variables.length)],
                    }))}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add variable
                    </Button>
                  </div>
                  {outline.variables.map((variable, index) => (
                    <div key={variable.stableSlotId} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[140px_130px_1fr_auto]">
                      <Input aria-label={`Variable ${index + 1} key`} value={variable.key} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateOutline((current) => ({
                        ...current,
                        variables: current.variables.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value, stableSlotId: item.stableSlotId.startsWith('slot_') ? event.target.value || item.stableSlotId : item.stableSlotId } : item),
                      }))} />
                      <Select value={variable.type} disabled={editingRoutine?.status === 'published'} onValueChange={(value) => updateOutline((current) => ({
                        ...current,
                        variables: current.variables.map((item, itemIndex) => itemIndex === index ? { ...item, type: value as RoutineSlotType } : item),
                      }))}>
                        <SelectTrigger aria-label={`Variable ${index + 1} type`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {slotTypes.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input aria-label={`Variable ${index + 1} description`} value={variable.description} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateOutline((current) => ({
                        ...current,
                        variables: current.variables.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item),
                      }))} />
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`outlineVariableRequired${index}`} className="text-xs">Required</Label>
                        <Switch id={`outlineVariableRequired${index}`} checked={variable.required} disabled={editingRoutine?.status === 'published'} onCheckedChange={(checked) => updateOutline((current) => ({
                          ...current,
                          variables: current.variables.map((item, itemIndex) => itemIndex === index ? { ...item, required: checked } : item),
                        }))} />
                        <Button type="button" variant="ghost" size="sm" disabled={editingRoutine?.status === 'published'} onClick={() => updateOutline((current) => ({
                          ...current,
                          variables: current.variables.filter((_, itemIndex) => itemIndex !== index),
                        }))} aria-label={`Remove variable ${variable.key || index + 1}`}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="sm:col-span-4">
                        <DiagnosticList diagnostics={diagnosticsForOutlineTarget(validation?.diagnostics ?? [], { scope: 'variable', id: variable.key })} />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h4 className="text-sm font-semibold text-foreground">Steps</h4>
                    <Button type="button" size="sm" variant="outline" disabled={editingRoutine?.status === 'published'} onClick={() => updateOutline((current) => ({
                      ...current,
                      steps: [...current.steps, createOutlineStep(current.steps.length)],
                    }))}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add step
                    </Button>
                  </div>
                  {outline.steps.map((step, stepIndex) => (
                    <div key={step.stableStepId} className="space-y-3 rounded-lg border border-border p-3">
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <div className="space-y-1">
                          <Label htmlFor={`outlineStepLabel${stepIndex}`}>Step {stepIndex + 1} label</Label>
                          <Input id={`outlineStepLabel${stepIndex}`} aria-label={`Outline step ${stepIndex + 1} label`} value={step.label} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateOutline((current) => ({
                            ...current,
                            steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                              ...item,
                              label: event.target.value,
                              stableStepId: item.stableStepId.startsWith('step_') ? event.target.value || item.stableStepId : item.stableStepId,
                            } : item),
                          }))} />
                        </div>
                        <div className="flex items-end gap-1">
                          <Button type="button" variant="ghost" size="sm" disabled={editingRoutine?.status === 'published' || stepIndex === 0} onClick={() => updateOutline((current) => {
                            const steps = [...current.steps]
                            const previous = steps[stepIndex - 1]
                            steps[stepIndex - 1] = steps[stepIndex]!
                            steps[stepIndex] = previous!
                            return { ...current, steps }
                          })} aria-label={`Move step ${stepIndex + 1} up`}>
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button type="button" variant="ghost" size="sm" disabled={editingRoutine?.status === 'published' || stepIndex === outline.steps.length - 1} onClick={() => updateOutline((current) => {
                            const steps = [...current.steps]
                            const next = steps[stepIndex + 1]
                            steps[stepIndex + 1] = steps[stepIndex]!
                            steps[stepIndex] = next!
                            return { ...current, steps }
                          })} aria-label={`Move step ${stepIndex + 1} down`}>
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                          <Button type="button" variant="ghost" size="sm" disabled={editingRoutine?.status === 'published'} onClick={() => updateOutline((current) => ({
                            ...current,
                            steps: current.steps.filter((_, itemIndex) => itemIndex !== stepIndex),
                          }))} aria-label={`Remove outline step ${step.label || stepIndex + 1}`}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Label htmlFor={`outlineStepInstruction${stepIndex}`}>Instruction</Label>
                          <div className="flex flex-wrap gap-2">
                            <VariableInsertButton
                              slotKeys={slotKeys}
                              ariaLabel={`Insert variable into outline step ${stepIndex + 1}`}
                              onInsert={(token) => insertOutlineToken(step.stableStepId, token.replace(/\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/u, '@$1'))}
                            />
                            <Select onValueChange={(ref) => {
                              const action = outlineActionOptions.find((option) => option.ref === ref)
                              if (action) insertOutlineToken(step.stableStepId, `@${action.label}`)
                            }}>
                              <SelectTrigger aria-label={`Insert action into outline step ${stepIndex + 1}`} className="h-8 w-[150px]">
                                <Wrench className="mr-2 h-4 w-4" />
                                <SelectValue placeholder="Insert action" />
                              </SelectTrigger>
                              <SelectContent>
                                {outlineActionOptions.map((action) => (
                                  <SelectItem key={action.ref} value={action.ref}>{action.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <Textarea
                          id={`outlineStepInstruction${stepIndex}`}
                          aria-label={`Outline step ${stepIndex + 1} instruction`}
                          ref={(element) => { outlineInstructionRefs.current[step.stableStepId] = element }}
                          value={step.instruction}
                          disabled={editingRoutine?.status === 'published'}
                          onChange={(event) => updateOutline((current) => ({
                            ...current,
                            steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? { ...item, instruction: event.target.value } : item),
                          }))}
                          rows={3}
                        />
                      </div>
                      <DiagnosticList diagnostics={diagnosticsForOutlineTarget(validation?.diagnostics ?? [], { scope: 'step', id: step.stableStepId })} />

                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-medium uppercase text-muted-foreground">Branches</p>
                          <Button type="button" size="sm" variant="outline" disabled={editingRoutine?.status === 'published'} aria-label={`Add branch to outline step ${stepIndex + 1}`} onClick={() => updateOutline((current) => ({
                            ...current,
                            steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                              ...item,
                              branches: [...item.branches, createOutlineBranch(item.stableStepId, item.branches.length, current.steps[stepIndex + 1]?.stableStepId ?? current.ends[0]?.stableStepId ?? '')],
                            } : item),
                          }))}>
                            <Plus className="mr-2 h-4 w-4" />
                            Add branch
                          </Button>
                        </div>
                        {step.branches.map((branch, branchIndex) => (
                          <div key={branch.id} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[minmax(0,1fr)_150px_120px_auto]">
                            <Input aria-label={`Outline step ${stepIndex + 1} branch ${branchIndex + 1} condition`} placeholder="Condition" value={branch.condition} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateOutline((current) => ({
                              ...current,
                              steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                                ...item,
                                branches: item.branches.map((candidate, candidateIndex) => candidateIndex === branchIndex ? { ...candidate, condition: event.target.value } : candidate),
                              } : item),
                            }))} />
                            <Select value={branch.targetRef} disabled={editingRoutine?.status === 'published'} onValueChange={(value) => updateOutline((current) => ({
                              ...current,
                              steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                                ...item,
                                branches: item.branches.map((candidate, candidateIndex) => candidateIndex === branchIndex ? { ...candidate, targetRef: value } : candidate),
                              } : item),
                            }))}>
                              <SelectTrigger aria-label={`Outline step ${stepIndex + 1} branch ${branchIndex + 1} target`}>
                                <SelectValue placeholder="Target" />
                              </SelectTrigger>
                              <SelectContent>
                                {[...outline.steps.map((candidate) => ({ value: candidate.stableStepId, label: candidate.label || candidate.stableStepId })), ...outline.ends.map((candidate) => ({ value: candidate.stableStepId, label: candidate.handoff ? `${candidate.label} handoff` : candidate.label }))].map((target) => (
                                  <SelectItem key={target.value} value={target.value}>{target.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Input aria-label={`Outline step ${stepIndex + 1} branch ${branchIndex + 1} counter limit`} type="number" placeholder="Max N" value={branch.counterLimit} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateOutline((current) => ({
                              ...current,
                              steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                                ...item,
                                branches: item.branches.map((candidate, candidateIndex) => candidateIndex === branchIndex ? { ...candidate, counterLimit: event.target.value } : candidate),
                              } : item),
                            }))} />
                            <Button type="button" variant="ghost" size="sm" disabled={editingRoutine?.status === 'published'} onClick={() => updateOutline((current) => ({
                              ...current,
                              steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                                ...item,
                                branches: item.branches.filter((_, candidateIndex) => candidateIndex !== branchIndex),
                              } : item),
                            }))} aria-label={`Remove outline step ${stepIndex + 1} branch ${branchIndex + 1}`}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                            {actionForOutlineStep(step) ? (
                              <Input aria-label={`Outline step ${stepIndex + 1} branch ${branchIndex + 1} outcome status`} className="sm:col-span-2" placeholder="Outcome status" value={branch.outcomeStatus} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateOutline((current) => ({
                                ...current,
                                steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                                  ...item,
                                  branches: item.branches.map((candidate, candidateIndex) => candidateIndex === branchIndex ? { ...candidate, outcomeStatus: event.target.value } : candidate),
                                } : item),
                              }))} />
                            ) : null}
                            <div className="sm:col-span-4">
                              <DiagnosticList diagnostics={diagnosticsForOutlineTarget(validation?.diagnostics ?? [], {
                                scope: 'branch',
                                id: `${step.stableStepId}->${branch.targetRef}`,
                              })} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h4 className="text-sm font-semibold text-foreground">Ends</h4>
                    <Button type="button" size="sm" variant="outline" disabled={editingRoutine?.status === 'published'} onClick={() => updateOutline((current) => ({
                      ...current,
                      ends: [...current.ends, createOutlineEnd(current.ends.length)],
                    }))}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add end
                    </Button>
                  </div>
                  {outline.ends.map((end, index) => (
                    <div key={end.stableStepId} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[160px_1fr_auto_auto]">
                      <Input aria-label={`End ${index + 1} label`} value={end.label} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateOutline((current) => ({
                        ...current,
                        ends: current.ends.map((item, itemIndex) => itemIndex === index ? {
                          ...item,
                          label: event.target.value,
                          stableStepId: item.stableStepId.startsWith('complete_') ? event.target.value || item.stableStepId : item.stableStepId,
                        } : item),
                      }))} />
                      <Input aria-label={`End ${index + 1} message`} value={end.message} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateOutline((current) => ({
                        ...current,
                        ends: current.ends.map((item, itemIndex) => itemIndex === index ? { ...item, message: event.target.value } : item),
                      }))} />
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`endHandoff${index}`} className="text-xs">Handoff</Label>
                        <Switch id={`endHandoff${index}`} checked={end.handoff} disabled={editingRoutine?.status === 'published'} onCheckedChange={(checked) => updateOutline((current) => ({
                          ...current,
                          ends: current.ends.map((item, itemIndex) => itemIndex === index ? { ...item, handoff: checked } : item),
                        }))} />
                      </div>
                      <Button type="button" variant="ghost" size="sm" disabled={editingRoutine?.status === 'published'} onClick={() => updateOutline((current) => ({
                        ...current,
                        ends: current.ends.filter((_, itemIndex) => itemIndex !== index),
                      }))} aria-label={`Remove end ${end.label || index + 1}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      <div className="sm:col-span-4">
                        <DiagnosticList diagnostics={diagnosticsForOutlineTarget(validation?.diagnostics ?? [], { scope: 'end', id: end.stableStepId })} />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {viewMode === 'form' ? (
              <>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-foreground">Slots</h4>
                <Button type="button" size="sm" variant="outline" disabled={editingRoutine?.status === 'published'} onClick={() => updateForm((current) => ({
                  ...current,
                  slots: [...current.slots, createSlotForm(current.slots.length)],
                }))}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add slot
                </Button>
              </div>
              {form.slots.map((slot, index) => (
                <div key={slot.stableSlotId} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[140px_130px_1fr_auto]">
                  <Input aria-label={`Slot ${index + 1} key`} value={slot.key} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateForm((current) => ({
                    ...current,
                    slots: current.slots.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value, stableSlotId: event.target.value || item.stableSlotId } : item),
                  }))} />
                  <Select value={slot.type} disabled={editingRoutine?.status === 'published'} onValueChange={(value) => updateForm((current) => ({
                    ...current,
                    slots: current.slots.map((item, itemIndex) => itemIndex === index ? { ...item, type: value as RoutineSlotType } : item),
                  }))}>
                    <SelectTrigger aria-label={`Slot ${index + 1} type`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {slotTypes.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input aria-label={`Slot ${index + 1} description`} value={slot.description} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateForm((current) => ({
                    ...current,
                    slots: current.slots.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item),
                  }))} />
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`slotRequired${index}`} className="text-xs">Required</Label>
                    <Switch id={`slotRequired${index}`} checked={slot.required} disabled={editingRoutine?.status === 'published'} onCheckedChange={(checked) => updateForm((current) => ({
                      ...current,
                      slots: current.slots.map((item, itemIndex) => itemIndex === index ? { ...item, required: checked } : item),
                    }))} />
                    <Button type="button" variant="ghost" size="sm" disabled={editingRoutine?.status === 'published'} onClick={() => updateForm((current) => ({
                      ...current,
                      slots: current.slots.filter((_, itemIndex) => itemIndex !== index),
                    }))} aria-label={`Remove slot ${slot.key || index + 1}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="sm:col-span-4">
                    <DiagnosticList diagnostics={diagnosticsForTarget(validation?.diagnostics ?? [], { scope: 'slot', id: slot.key })} />
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-foreground">Steps</h4>
                <Button type="button" size="sm" variant="outline" disabled={editingRoutine?.status === 'published'} onClick={() => updateForm((current) => ({
                  ...current,
                  steps: [...current.steps, createStepForm(current.steps.length)],
                }))}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add step
                </Button>
              </div>
              {form.steps.map((step, stepIndex) => (
                <div key={step.stableStepId} className="space-y-3 rounded-lg border border-border p-3">
                  <div className="grid gap-3 sm:grid-cols-[160px_130px_1fr_auto]">
                    <Input aria-label={`Step ${stepIndex + 1} id`} value={step.stableStepId} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateForm((current) => ({
                      ...current,
                      steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? { ...item, stableStepId: event.target.value } : item),
                    }))} />
                    <Select value={step.kind} disabled={editingRoutine?.status === 'published'} onValueChange={(value) => updateForm((current) => ({
                      ...current,
                      steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? { ...item, kind: value as 'chat' | 'tool' | 'action' } : item),
                    }))}>
                      <SelectTrigger aria-label={`Step ${stepIndex + 1} kind`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {stepKinds.map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {step.kind === 'tool' ? (
                      <Input aria-label={`Step ${stepIndex + 1} tool reference`} value={step.toolRef} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateForm((current) => ({
                        ...current,
                        steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? { ...item, toolRef: event.target.value } : item),
                      }))} />
                    ) : step.kind === 'action' ? (
                      <Input aria-label={`Step ${stepIndex + 1} action type`} value={step.actionType} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateForm((current) => ({
                        ...current,
                        steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? { ...item, actionType: event.target.value } : item),
                      }))} />
                    ) : <div />}
                    <Button type="button" variant="ghost" size="sm" disabled={editingRoutine?.status === 'published'} onClick={() => updateForm((current) => ({
                      ...current,
                      steps: current.steps.filter((_, itemIndex) => itemIndex !== stepIndex),
                    }))} aria-label={`Remove step ${step.stableStepId}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Label htmlFor={`stepInstruction${stepIndex}`}>Instruction</Label>
                      <VariableInsertButton
                        slotKeys={slotKeys}
                        ariaLabel={`Insert variable into step ${stepIndex + 1}`}
                        onInsert={(token) => insertVariable(step.stableStepId, token)}
                      />
                    </div>
                    <Textarea
                      id={`stepInstruction${stepIndex}`}
                      aria-label={`Step ${stepIndex + 1} instruction`}
                      ref={(element) => { instructionRefs.current[step.stableStepId] = element }}
                      value={step.instruction}
                      disabled={editingRoutine?.status === 'published'}
                      onChange={(event) => updateForm((current) => ({
                        ...current,
                        steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? { ...item, instruction: event.target.value } : item),
                      }))}
                      rows={3}
                    />
                  </div>
                  <DiagnosticList diagnostics={diagnosticsForTarget(validation?.diagnostics ?? [], { scope: 'step', id: step.stableStepId })} />

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-medium uppercase text-muted-foreground">Transitions</p>
                      <Button type="button" size="sm" variant="outline" disabled={editingRoutine?.status === 'published'} onClick={() => updateForm((current) => ({
                        ...current,
                        steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                          ...item,
                          transitions: [...item.transitions, createTransitionForm(item.stableStepId, current.terminals[0]?.stableStepId ?? '')],
                        } : item),
                      }))}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add transition
                      </Button>
                    </div>
                    {step.transitions.map((transition, transitionIndex) => (
                      <div key={`${transition.fromStep}-${transitionIndex}`} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[150px_140px_1fr_auto]">
                        <Select value={transition.toRef} disabled={editingRoutine?.status === 'published'} onValueChange={(value) => updateForm((current) => ({
                          ...current,
                          steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                            ...item,
                            transitions: item.transitions.map((candidate, candidateIndex) => candidateIndex === transitionIndex ? { ...candidate, toRef: value } : candidate),
                          } : item),
                        }))}>
                          <SelectTrigger aria-label={`Transition ${transitionIndex + 1} target`}>
                            <SelectValue placeholder="Target" />
                          </SelectTrigger>
                          <SelectContent>
                            {[...form.steps.map((candidate) => candidate.stableStepId), ...form.terminals.map((candidate) => candidate.stableStepId)].map((id) => (
                              <SelectItem key={id} value={id}>{id}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select value={transition.guardKind} disabled={editingRoutine?.status === 'published'} onValueChange={(value) => updateForm((current) => ({
                          ...current,
                          steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                            ...item,
                            transitions: item.transitions.map((candidate, candidateIndex) => candidateIndex === transitionIndex ? { ...candidate, guardKind: value as RoutineGuardKind } : candidate),
                          } : item),
                        }))}>
                          <SelectTrigger aria-label={`Transition ${transitionIndex + 1} guard`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {guardKinds.map((kind) => <SelectItem key={kind} value={kind}>{optionLabel(kind)}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {transition.guardKind === 'outcome' ? (
                          <Input aria-label={`Transition ${transitionIndex + 1} outcome`} placeholder="Outcome status" value={transition.outcomeStatus} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateForm((current) => ({
                            ...current,
                            steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                              ...item,
                              transitions: item.transitions.map((candidate, candidateIndex) => candidateIndex === transitionIndex ? { ...candidate, outcomeStatus: event.target.value } : candidate),
                            } : item),
                          }))} />
                        ) : transition.guardKind === 'counter' ? (
                          <Input aria-label={`Transition ${transitionIndex + 1} counter limit`} type="number" placeholder="Limit" value={transition.counterLimit} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateForm((current) => ({
                            ...current,
                            steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                              ...item,
                              transitions: item.transitions.map((candidate, candidateIndex) => candidateIndex === transitionIndex ? { ...candidate, counterLimit: event.target.value } : candidate),
                            } : item),
                          }))} />
                        ) : (
                          <Input aria-label={`Transition ${transitionIndex + 1} condition`} placeholder="Guard text" value={transition.guardText} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateForm((current) => ({
                            ...current,
                            steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                              ...item,
                              transitions: item.transitions.map((candidate, candidateIndex) => candidateIndex === transitionIndex ? { ...candidate, guardText: event.target.value } : candidate),
                            } : item),
                          }))} />
                        )}
                        <Button type="button" variant="ghost" size="sm" disabled={editingRoutine?.status === 'published'} onClick={() => updateForm((current) => ({
                          ...current,
                          steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                            ...item,
                            transitions: item.transitions.filter((_, candidateIndex) => candidateIndex !== transitionIndex),
                          } : item),
                        }))} aria-label={`Remove transition ${transitionIndex + 1}`}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                        <div className="sm:col-span-4">
                          <DiagnosticList diagnostics={diagnosticsForTarget(validation?.diagnostics ?? [], {
                            scope: 'transition',
                            id: `${transition.fromStep}->${transition.toRef}`,
                          })} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-foreground">Terminals</h4>
                <Button type="button" size="sm" variant="outline" disabled={editingRoutine?.status === 'published'} onClick={() => updateForm((current) => ({
                  ...current,
                  terminals: [...current.terminals, createTerminalForm(current.terminals.length)],
                }))}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add terminal
                </Button>
              </div>
              {form.terminals.map((terminal, index) => (
                <div key={terminal.stableStepId} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[160px_140px_1fr_auto]">
                  <Input aria-label={`Terminal ${index + 1} id`} value={terminal.stableStepId} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateForm((current) => ({
                    ...current,
                    terminals: current.terminals.map((item, itemIndex) => itemIndex === index ? { ...item, stableStepId: event.target.value } : item),
                  }))} />
                  <Select value={terminal.kind} disabled={editingRoutine?.status === 'published'} onValueChange={(value) => updateForm((current) => ({
                    ...current,
                    terminals: current.terminals.map((item, itemIndex) => itemIndex === index ? { ...item, kind: value as RoutineTerminalKind } : item),
                  }))}>
                    <SelectTrigger aria-label={`Terminal ${index + 1} kind`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {terminalKinds.map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input aria-label={`Terminal ${index + 1} instruction`} value={terminal.instruction} disabled={editingRoutine?.status === 'published'} onChange={(event) => updateForm((current) => ({
                    ...current,
                    terminals: current.terminals.map((item, itemIndex) => itemIndex === index ? { ...item, instruction: event.target.value } : item),
                  }))} />
                  <Button type="button" variant="ghost" size="sm" disabled={editingRoutine?.status === 'published'} onClick={() => updateForm((current) => ({
                    ...current,
                    terminals: current.terminals.filter((_, itemIndex) => itemIndex !== index),
                  }))} aria-label={`Remove terminal ${terminal.stableStepId}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  <div className="sm:col-span-4">
                    <DiagnosticList diagnostics={diagnosticsForTarget(validation?.diagnostics ?? [], { scope: 'terminal', id: terminal.stableStepId })} />
                  </div>
                </div>
              ))}
            </div>
              </>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => {
                setForm(null)
                setOutline(null)
                setEditingRoutineId(null)
                setDraftHeader(headerFromDraft(createEmptyRoutineOutline()))
              }}>
                Close
              </Button>
              <Button type="button" variant="outline" onClick={() => void saveDraft()} disabled={isSaving || editingRoutine?.status === 'published'}>
                Save draft
              </Button>
              <Button type="button" variant="outline" onClick={() => void validateDraft()} disabled={isSaving || editingRoutine?.status === 'published'}>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Validate
              </Button>
              <Button type="button" onClick={() => void publishDraft()} disabled={isSaving || editingRoutine?.status === 'published'}>
                <Send className="mr-2 h-4 w-4" />
                Publish
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </SettingsCard>
  )
}
