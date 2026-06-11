'use client'

import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, FormInput, ListTree, Pencil, Plus, Route, Send, Trash2 } from 'lucide-react'

import { RoutineDraftAssistDialog } from '@/components/dashboard/settings/routine-draft-assist-dialog'
import { RoutineDiagnosticList } from '@/components/dashboard/settings/routine-editor-controls'
import { RoutineFormEditor } from '@/components/dashboard/settings/routine-form-editor'
import { RoutineOutlineEditor } from '@/components/dashboard/settings/routine-outline-editor'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  RoutinePublishRejectedError,
  routinesApi,
  type RoutineDefinition,
  type RoutineDefinitionDraft,
  type RoutineValidationResult,
} from '@/lib/api'
import {
  diagnosticTargetFor,
  formToRoutineDraft,
  routineToForm,
  type RoutineDraftHeader,
  type RoutineFormState,
} from '@/lib/routine-form'
import {
  createEmptyRoutineOutline,
  outlineToRoutineDraft,
  routineDraftProposalToOutline,
  routineDraftToOutline,
  type RoutineOutlineActionOption,
  type RoutineOutlineState,
} from '@/lib/routine-outline'

const outlineActionOptions: RoutineOutlineActionOption[] = [
  { ref: 'contact.send', label: 'Contact Send', kind: 'action' },
]

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
  const [isDraftingFromProcedure, setIsDraftingFromProcedure] = useState(false)
  const [draftAssistOpen, setDraftAssistOpen] = useState(false)
  const [draftAssistProse, setDraftAssistProse] = useState('')
  const [error, setError] = useState<string | null>(null)
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
  const validationDiagnostics = validation?.diagnostics ?? []
  const isPublished = editingRoutine?.status === 'published'

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
    setDraftAssistOpen(false)
    setDraftAssistProse('')
  }

  const startEdit = (routine: RoutineDefinition) => {
    setEditingRoutineId(routine.id)
    setDraftHeader(headerFromDraft(routine))
    setForm(routineToForm(routine))
    setOutline(routineDraftToOutline(routine, { actionOptions: outlineActionOptions }))
    setViewMode('outline')
    setValidation(null)
    setError(null)
    setDraftAssistOpen(false)
    setDraftAssistProse('')
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

  const draftFromProcedure = async () => {
    const prose = draftAssistProse.trim()
    if (!outline || !prose || editingRoutineId) return
    setIsDraftingFromProcedure(true)
    setError(null)
    try {
      const response = await routinesApi.draftRoutineFromProcedure(agentId, { prose })
      const nextOutline = routineDraftProposalToOutline(response.draft, { actionOptions: outlineActionOptions })
      setDraftHeader(headerFromDraft(response.draft))
      setOutline(nextOutline)
      setForm(routineToForm(draftAsRoutine(response.draft)))
      setValidation(response.validation)
      setViewMode('outline')
      setDraftAssistOpen(false)
      setDraftAssistProse('')
    } catch (assistError) {
      setError(getApiErrorMessage(assistError, 'Failed to draft routine from procedure.'))
    } finally {
      setIsDraftingFromProcedure(false)
    }
  }

  const updateForm = (updater: (current: RoutineFormState) => RoutineFormState) => {
    setForm((current) => current ? updater(current) : current)
  }

  const updateOutline = (updater: (current: RoutineOutlineState) => RoutineOutlineState) => {
    setOutline((current) => current ? updater(current) : current)
  }

  const closeEditor = () => {
    setForm(null)
    setOutline(null)
    setEditingRoutineId(null)
    setDraftHeader(headerFromDraft(createEmptyRoutineOutline()))
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
                  disabled={isPublished}
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
                  disabled={isPublished}
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
                  disabled={isPublished}
                />
              </div>
            </div>
            <RoutineDiagnosticList diagnostics={routineDiagnostics} />

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

            {viewMode === 'outline' && outline && !editingRoutineId ? (
              <RoutineDraftAssistDialog
                isOpen={draftAssistOpen}
                isDrafting={isDraftingFromProcedure}
                prose={draftAssistProse}
                onOpenChange={setDraftAssistOpen}
                onProseChange={setDraftAssistProse}
                onLoadProposal={() => void draftFromProcedure()}
              />
            ) : null}

            {viewMode === 'outline' && outline ? (
              <RoutineOutlineEditor
                outline={outline}
                diagnostics={validationDiagnostics}
                isPublished={isPublished}
                slotKeys={slotKeys}
                actionOptions={outlineActionOptions}
                onChange={updateOutline}
              />
            ) : null}

            {viewMode === 'form' ? (
              <RoutineFormEditor
                form={form}
                diagnostics={validationDiagnostics}
                isPublished={isPublished}
                slotKeys={slotKeys}
                onChange={updateForm}
              />
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" onClick={closeEditor}>
                Close
              </Button>
              <Button type="button" variant="outline" onClick={() => void saveDraft()} disabled={isSaving || isPublished}>
                Save draft
              </Button>
              <Button type="button" variant="outline" onClick={() => void validateDraft()} disabled={isSaving || isPublished}>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Validate
              </Button>
              <Button type="button" onClick={() => void publishDraft()} disabled={isSaving || isPublished}>
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
