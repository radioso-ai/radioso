'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Eye,
  FormInput,
  History,
  Pencil,
  Plus,
  RotateCcw,
  Route,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react'

import { RoutineDiagnosticList } from '@/components/dashboard/settings/routine-editor-controls'
import { RoutineFormEditor } from '@/components/dashboard/settings/routine-form-editor'
import { RoutineProseEditor } from '@/components/dashboard/settings/routine-prose-editor'
import { RoutineProseTab } from '@/components/dashboard/settings/routine-prose-tab'
import { RoutineSkillCatalogProvider } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { getApiErrorMessage } from '@/lib/api-error'
import { customerEmailApi, type CustomerEmailSkillDefinition } from '@/lib/api-customer-email'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import {
  RoutinePublishRejectedError,
  routinesApi,
  webhookDestinationsApi,
  type RoutineDefinition,
  type RoutineDefinitionDraft,
  type RoutineReentryMode,
  type RoutineValidationResult,
  type WebhookDestination,
} from '@/lib/api'
import { getRoutineLineageVersions, groupRoutineLineages, type RoutineLineageGroup } from '@/lib/routine-lineage'
import {
  diagnosticTargetFor,
  formToRoutineDraft,
  routineToForm,
  type RoutineDraftHeader,
  type RoutineFormState,
} from '@/lib/routine-form'
import { createEmptyRoutineProseDraft, routineToChipDoc } from '@/lib/routine-prose'

// A blank routine for the Form tab: one empty step the author fills in, no transitions
// yet, and a single complete terminal. The Prose tab starts from the steps-stripped
// variant (an empty document) so the editor shows its placeholder.
const emptyRoutineDraft = (): RoutineDefinitionDraft => ({
  name: '',
  activation: { triggerDescription: '', gateRef: null, priority: 0 },
  slots: [],
  steps: [{ stableStepId: 'step_1', kind: 'chat', instruction: '', toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
  transitions: [],
  terminals: [{ stableStepId: 'complete', kind: 'complete', instruction: 'Confirm completion.', ordinal: 0 }],
})

// Author-facing reentry policy options. Order puts the safe default first.
const REENTRY_MODE_OPTIONS: { value: RoutineReentryMode; label: string; hint: string }[] = [
  { value: 'once_per_conversation', label: 'Once per conversation', hint: 'Runs a single time; suppressed after it completes.' },
  { value: 'always', label: 'Every time it matches', hint: 'Can run again after it completes.' },
  { value: 'semantic', label: 'Let the assistant decide', hint: 'After it completes, the assistant decides whether to resume, restart, or skip it.' },
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
  if (draft.completionExport?.enabled && !draft.completionExport.destinationRef.trim()) {
    return 'Completion export needs a webhook destination.'
  }
  if (draft.completionExport?.enabled && draft.completionExport.triggerKinds.length === 0) {
    return 'Completion export needs at least one terminal trigger.'
  }
  return null
}

const draftAsRoutine = (draft: RoutineDefinitionDraft, routine?: RoutineDefinition | null): RoutineDefinition => ({
  ...draft,
  id: routine?.id ?? 'local-draft',
  lineageId: routine?.lineageId ?? 'local-lineage',
  agentId: routine?.agentId ?? 'local-agent',
  version: routine?.version ?? 1,
  status: routine?.status ?? 'draft',
  createdAt: routine?.createdAt ?? new Date(0).toISOString(),
  updatedAt: routine?.updatedAt ?? new Date(0).toISOString(),
})

const headerFromDraft = (draft: RoutineDefinitionDraft | RoutineDefinition | RoutineFormState): RoutineDraftHeader => ({
  name: draft.name,
  activation: {
    triggerDescription: draft.activation.triggerDescription,
    priority: String(draft.activation.priority),
    reentryMode: draft.activation.reentryMode ?? 'once_per_conversation',
  },
})

const emptyProseDraftFromHeader = (header: RoutineDraftHeader): RoutineDefinitionDraft =>
  createEmptyRoutineProseDraft({
    name: header.name,
    triggerDescription: header.activation.triggerDescription,
    priority: Number.parseInt(header.activation.priority, 10) || 0,
    reentryMode: header.activation.reentryMode,
  })

const isBlankFormDraft = (draft: RoutineDefinitionDraft): boolean =>
  draft.slots.length === 0 &&
  draft.steps.length === 1 &&
  draft.transitions.length === 0 &&
  !draft.completionExport?.enabled &&
  draft.steps[0]?.kind === 'chat' &&
  !draft.steps[0]?.instruction.trim() &&
  !draft.steps[0]?.toolRef &&
  !draft.steps[0]?.actionType

const routineStatusLabel = (status: RoutineDefinition['status']) => {
  switch (status) {
    case 'draft':
      return 'draft'
    case 'published':
      return 'published'
    case 'superseded':
      return 'superseded'
    case 'archived':
      return 'archived'
  }
}

const lineageStateLabel = (lineage: RoutineLineageGroup) => {
  if (lineage.state === 'draft-only') return 'draft only'
  if (lineage.state === 'draft-with-archived') return 'draft + archived'
  return lineage.state
}

const formatRoutineDate = (value: string) => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(value))

const replaceBrowserUrl = (href: string) => {
  if (typeof window === 'undefined') return
  window.history.replaceState(window.history.state, '', href)
}

export function AssistantRoutinesSection({
  accountId,
  agentId,
  routeState,
  onSaveStateChange,
}: {
  accountId: string
  agentId: string
  routeState?: DashboardRouteState
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  if (routeState?.agentRoutineId) {
    return (
      <RoutineEditorScreen
        accountId={accountId}
        agentId={agentId}
        routeState={routeState}
        routineRouteId={routeState.agentRoutineId}
        onSaveStateChange={onSaveStateChange}
      />
    )
  }

  return (
    <RoutineListScreen
      accountId={accountId}
      agentId={agentId}
      routeState={routeState}
    />
  )
}

function RoutineListScreen({
  accountId,
  agentId,
  routeState,
}: {
  accountId: string
  agentId: string
  routeState?: DashboardRouteState
}) {
  const router = useRouter()
  const [routines, setRoutines] = useState<RoutineDefinition[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [proseOpen, setProseOpen] = useState(false)

  const groupedRoutines = useMemo(
    () => groupRoutineLineages(routines),
    [routines],
  )

  const buildRoutineHref = (routineId: string) =>
    buildDashboardHref(accountId, {
      ...(routeState ?? { section: 'agents' }),
      section: 'agents',
      agentId,
      agentRoutineId: routineId,
      agentTab: undefined,
      anchor: undefined,
    })

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

  const deleteDraft = async (routine: RoutineDefinition) => {
    if (routine.status !== 'draft') return
    setError(null)
    try {
      await routinesApi.deleteRoutine(agentId, routine.id)
      setRoutines((current) => current.filter((item) => item.id !== routine.id))
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete routine draft.'))
    }
  }

  const mergeRoutine = (routine: RoutineDefinition) => {
    setRoutines((current) => {
      const withoutCurrent = current.filter((item) => item.id !== routine.id)
      return [...withoutCurrent, routine]
    })
  }

  const reviseRoutine = async (routine: RoutineDefinition) => {
    setError(null)
    try {
      const response = await routinesApi.reviseRoutine(agentId, routine.id)
      mergeRoutine(response.routine)
      router.push(buildRoutineHref(response.routine.id))
    } catch (reviseError) {
      setError(getApiErrorMessage(reviseError, 'Failed to create routine revision.'))
    }
  }

  const restoreRoutine = async (routine: RoutineDefinition) => {
    setError(null)
    try {
      const response = await routinesApi.restoreRoutine(agentId, routine.id)
      mergeRoutine(response.routine)
    } catch (restoreError) {
      setError(getApiErrorMessage(restoreError, 'Failed to restore routine.'))
    }
  }

  const renderLineageRow = (lineage: RoutineLineageGroup) => {
    const routine = lineage.displayRoutine
    const activeVersion = lineage.activeRoutine?.version ?? routine.version
    return (
      <div key={lineage.lineageId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => router.push(buildRoutineHref(routine.id))}
        >
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">{lineage.name}</p>
            <Badge variant="outline">{lineageStateLabel(lineage)}</Badge>
            <span className="text-xs text-muted-foreground">v{activeVersion}</span>
            {lineage.pendingDraft ? (
              <Badge variant="secondary">draft revision</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{lineage.triggerDescription}</p>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {routine.status === 'draft' ? (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => router.push(buildRoutineHref(routine.id))} aria-label={`Edit draft ${routine.name}`}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void deleteDraft(routine)} aria-label={`Delete draft ${routine.name}`}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          ) : null}
          {routine.status === 'published' ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void reviseRoutine(routine)} aria-label={`Edit ${routine.name}`}>
              <Pencil className="h-4 w-4" />
            </Button>
          ) : null}
          {routine.status === 'archived' ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void restoreRoutine(routine)} aria-label={`Restore ${routine.name}`}>
              <RotateCcw className="h-4 w-4" />
            </Button>
          ) : null}
          {routine.status === 'superseded' ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => router.push(buildRoutineHref(routine.id))} aria-label={`View ${routine.name}`}>
              <Eye className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  if (proseOpen) {
    return (
      <RoutineProseEditor
        agentId={agentId}
        onClose={() => setProseOpen(false)}
        onCreated={(routine) => {
          setProseOpen(false)
          router.push(buildRoutineHref(routine.id))
        }}
      />
    )
  }

  return (
    <SettingsCard
      id="assistant-routines-card"
      icon={<Route className="h-5 w-5 text-primary" />}
      title="Routines"
      description="Multi-step procedures the agent runs to complete a task — collect details, call a skill, then finish or hand off. Reach for a routine when a single directive isn't enough. Validate and publish before it goes live."
      headerEnd={(
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setProseOpen(true)}>
            <Sparkles className="mr-2 h-4 w-4" />
            Write in prose
          </Button>
          <Button type="button" size="sm" onClick={() => router.push(buildRoutineHref('new'))}>
            <Plus className="mr-2 h-4 w-4" />
            New routine
          </Button>
        </div>
      )}
    >
      <div className="space-y-6">
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading routines...
          </div>
        ) : groupedRoutines.active.length === 0 && groupedRoutines.archived.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No routines yet.
          </p>
        ) : (
          <div className="space-y-3">
            {groupedRoutines.active.map(renderLineageRow)}
            {groupedRoutines.archived.length > 0 ? (
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" className="h-8 px-2 text-xs text-muted-foreground">
                    <ChevronDown className="mr-1 h-4 w-4" />
                    Archived routines ({groupedRoutines.archived.length})
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-3 pt-2">
                  {groupedRoutines.archived.map(renderLineageRow)}
                </CollapsibleContent>
              </Collapsible>
            ) : null}
          </div>
        )}
      </div>
    </SettingsCard>
  )
}

function RoutineEditorScreen({
  accountId,
  agentId,
  routeState,
  routineRouteId,
  onSaveStateChange,
}: {
  accountId: string
  agentId: string
  routeState: DashboardRouteState
  routineRouteId: string
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  const router = useRouter()
  const isNewRoutine = routineRouteId === 'new'
  const [editingRoutineId, setEditingRoutineId] = useState<string | null>(isNewRoutine ? null : routineRouteId)
  const [editingRoutine, setEditingRoutine] = useState<RoutineDefinition | null>(null)
  const [allRoutines, setAllRoutines] = useState<RoutineDefinition[]>([])
  const [form, setForm] = useState<RoutineFormState | null>(null)
  const [proseSource, setProseSource] = useState<RoutineDefinitionDraft | null>(null)
  const [proseDraft, setProseDraft] = useState<RoutineDefinitionDraft | null>(null)
  const [proseKey, setProseKey] = useState(0)
  const [draftHeader, setDraftHeader] = useState<RoutineDraftHeader>(() => headerFromDraft(emptyRoutineDraft()))
  const [viewMode, setViewMode] = useState<'prose' | 'form'>('prose')
  const [validation, setValidation] = useState<RoutineValidationResult | null>(null)
  const [isLoading, setIsLoading] = useState(!isNewRoutine)
  const [isSaving, setIsSaving] = useState(false)
  const [webhookDestinations, setWebhookDestinations] = useState<WebhookDestination[]>([])
  const [isWebhookDestinationsLoading, setIsWebhookDestinationsLoading] = useState(true)
  const [webhookDestinationsError, setWebhookDestinationsError] = useState<string | null>(null)
  const [emailSkills, setEmailSkills] = useState<CustomerEmailSkillDefinition[]>([])
  const [error, setError] = useState<string | null>(null)
  const currentRoutineIdRef = useRef<string | null>(null)
  const { beginSave, isCurrentSave, markError, markSaved } = useSettingsSaveStatus(onSaveStateChange)

  const listHref = buildDashboardHref(accountId, {
    section: 'agents',
    workspaceId: routeState.workspaceId,
    workspacePublicRouteKey: routeState.workspacePublicRouteKey,
    agentId,
    agentRoutineId: undefined,
    agentTab: 'behavior',
    anchor: 'assistant-routines',
  })

  const buildPersistedHref = (routineId: string) =>
    buildDashboardHref(accountId, {
      ...routeState,
      section: 'agents',
      agentId,
      agentRoutineId: routineId,
      agentTab: undefined,
      anchor: undefined,
    })

  const mergeLoadedRoutine = (routine: RoutineDefinition) => {
    setAllRoutines((current) => {
      const withoutCurrent = current.filter((item) => item.id !== routine.id)
      return [...withoutCurrent, routine]
    })
  }

  const slotKeys = useMemo(
    () => form?.slots.map((slot) => slot.key.trim()).filter(Boolean) ?? [],
    [form],
  )
  const routineDiagnostics = useMemo(
    () => (validation?.diagnostics ?? []).filter((diagnostic) => diagnosticTargetFor(diagnostic).scope === 'routine'),
    [validation],
  )
  const validationDiagnostics = validation?.diagnostics ?? []
  const isReadOnly = editingRoutine ? editingRoutine.status !== 'draft' : false
  const versionHistory = useMemo(
    () => getRoutineLineageVersions(allRoutines, editingRoutine?.lineageId),
    [allRoutines, editingRoutine?.lineageId],
  )

  useEffect(() => {
    currentRoutineIdRef.current = editingRoutine?.id ?? null
  }, [editingRoutine?.id])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setIsWebhookDestinationsLoading(true)
      setWebhookDestinationsError(null)
      void webhookDestinationsApi.listDestinations()
        .then((response) => {
          if (!active) return
          setWebhookDestinations(response.destinations)
        })
        .catch((loadError) => {
          if (!active) return
          setWebhookDestinationsError(getApiErrorMessage(loadError, 'Failed to load webhook destinations.'))
        })
        .finally(() => {
          if (active) setIsWebhookDestinationsLoading(false)
        })
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      void customerEmailApi.listEmailSkills(agentId)
        .then((response) => {
          if (active) setEmailSkills(response.skills)
        })
        .catch(() => {
          if (active) setEmailSkills([])
        })
    })
    return () => {
      active = false
    }
  }, [agentId])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      if (routineRouteId !== 'new' && currentRoutineIdRef.current === routineRouteId) {
        setIsLoading(false)
        return
      }

      setValidation(null)
      setError(null)

      if (routineRouteId === 'new') {
        const nextDraft = emptyRoutineDraft()
        const nextHeader = headerFromDraft(nextDraft)
        currentRoutineIdRef.current = null
        setEditingRoutineId(null)
        setEditingRoutine(null)
        setAllRoutines([])
        setDraftHeader(nextHeader)
        setForm(routineToForm(draftAsRoutine(nextDraft)))
        setProseSource(emptyProseDraftFromHeader(nextHeader))
        setProseDraft(null)
        setProseKey((key) => key + 1)
        setViewMode('prose')
        setIsLoading(false)
        return
      }

      currentRoutineIdRef.current = null
      setEditingRoutineId(routineRouteId)
      setEditingRoutine(null)
      setForm(null)
      setProseSource(null)
      setIsLoading(true)
      void Promise.all([
        routinesApi.getRoutine(agentId, routineRouteId),
        routinesApi.listRoutines(agentId).catch(() => ({ routines: [] })),
      ])
        .then(([response, listResponse]) => {
          if (!active) return
          currentRoutineIdRef.current = response.routine.id
          setEditingRoutine(response.routine)
          setEditingRoutineId(response.routine.id)
          setAllRoutines(listResponse.routines)
          setDraftHeader(headerFromDraft(response.routine))
          setForm(routineToForm(response.routine))
          setProseSource(response.routine)
          setProseDraft(null)
          setProseKey((key) => key + 1)
          // Prose-representable drafts open in the prose editor; advanced routines and
          // read-only (non-draft) versions open in the strict Form tab.
          const editable = response.routine.status === 'draft'
          setViewMode(editable && routineToChipDoc(response.routine) ? 'prose' : 'form')
        })
        .catch((loadError) => {
          if (!active) return
          setError(getApiErrorMessage(loadError, 'Failed to load routine.'))
        })
        .finally(() => {
          if (active) setIsLoading(false)
        })
    })

    return () => {
      active = false
    }
  }, [agentId, routineRouteId])

  const activeDraft = (): RoutineDefinitionDraft | null => {
    if (viewMode === 'prose') {
      return proseDraft
    }
    return form ? formToRoutineDraft(form, { header: draftHeader }) : null
  }

  const synchronizeView = (nextView: 'prose' | 'form') => {
    if (nextView === viewMode) return
    if (nextView === 'form' && proseDraft && proseDraft.steps.length > 0) {
      setForm(routineToForm(draftAsRoutine(proseDraft, editingRoutine)))
    }
    if (nextView === 'prose' && form) {
      // Re-seed prose from the current form draft; routineToChipDoc inside the prose tab
      // decides whether it's representable (else it shows the "edit in Form" fallback).
      const formDraft = formToRoutineDraft(form, { header: draftHeader })
      setProseSource(isBlankFormDraft(formDraft) ? emptyProseDraftFromHeader(draftHeader) : formDraft)
      setProseDraft(null)
      setProseKey((key) => key + 1)
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
    const wasNew = !editingRoutineId
    setIsSaving(true)
    setError(null)
    try {
      const response = editingRoutineId
        ? await routinesApi.updateRoutine(agentId, editingRoutineId, draft)
        : await routinesApi.createRoutine(agentId, draft)
      if (!isCurrentSave(saveId)) return null
      currentRoutineIdRef.current = response.routine.id
      setEditingRoutine(response.routine)
      setEditingRoutineId(response.routine.id)
      mergeLoadedRoutine(response.routine)
      setDraftHeader(headerFromDraft(response.routine))
      setForm(routineToForm(response.routine))
      setProseSource(response.routine)
      setProseDraft(null)
      setProseKey((key) => key + 1)
      setValidation(response.validation)
      markSaved()
      if (wasNew) {
        replaceBrowserUrl(buildPersistedHref(response.routine.id))
      }
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
    const routine = await saveDraft()
    if (!routine) return
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    try {
      const response = await routinesApi.publishRoutine(agentId, routine.id)
      if (!isCurrentSave(saveId)) return
      currentRoutineIdRef.current = response.routine.id
      setEditingRoutine(response.routine)
      setEditingRoutineId(response.routine.id)
      setAllRoutines((current) => current
        .filter((item) => item.id !== routine.id)
        .map((item) => item.lineageId === response.routine.lineageId && item.status === 'published'
          ? { ...item, status: 'superseded' as const, updatedAt: response.routine.updatedAt }
          : item)
        .concat(response.routine))
      setValidation(response.validation)
      markSaved()
      router.replace(buildPersistedHref(response.routine.id))
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

  const deleteDraft = async () => {
    if (!editingRoutine || editingRoutine.status !== 'draft') return
    setIsSaving(true)
    setError(null)
    try {
      await routinesApi.deleteRoutine(agentId, editingRoutine.id)
      router.push(listHref)
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete routine draft.'))
    } finally {
      setIsSaving(false)
    }
  }

  const revisePublished = async () => {
    if (!editingRoutine || editingRoutine.status !== 'published') return
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    try {
      const response = await routinesApi.reviseRoutine(agentId, editingRoutine.id)
      if (!isCurrentSave(saveId)) return
      currentRoutineIdRef.current = response.routine.id
      setEditingRoutine(response.routine)
      setEditingRoutineId(response.routine.id)
      mergeLoadedRoutine(response.routine)
      setDraftHeader(headerFromDraft(response.routine))
      setForm(routineToForm(response.routine))
      setProseSource(response.routine)
      setProseDraft(null)
      setProseKey((key) => key + 1)
      setValidation(null)
      markSaved()
      router.replace(buildPersistedHref(response.routine.id))
    } catch (reviseError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(reviseError, 'Failed to create routine revision.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) setIsSaving(false)
    }
  }

  const archivePublished = async () => {
    if (!editingRoutine || editingRoutine.status !== 'published') return
    setIsSaving(true)
    setError(null)
    try {
      const response = await routinesApi.archiveRoutine(agentId, editingRoutine.id)
      currentRoutineIdRef.current = response.routine.id
      setEditingRoutine(response.routine)
      setEditingRoutineId(response.routine.id)
      mergeLoadedRoutine(response.routine)
      setDraftHeader(headerFromDraft(response.routine))
      setForm(routineToForm(response.routine))
      setProseSource(response.routine)
      setProseDraft(null)
      setProseKey((key) => key + 1)
    } catch (archiveError) {
      setError(getApiErrorMessage(archiveError, 'Failed to archive routine.'))
    } finally {
      setIsSaving(false)
    }
  }

  const restoreArchived = async () => {
    if (!editingRoutine || editingRoutine.status !== 'archived') return
    setIsSaving(true)
    setError(null)
    try {
      const response = await routinesApi.restoreRoutine(agentId, editingRoutine.id)
      currentRoutineIdRef.current = response.routine.id
      setEditingRoutine(response.routine)
      setEditingRoutineId(response.routine.id)
      mergeLoadedRoutine(response.routine)
      setDraftHeader(headerFromDraft(response.routine))
      setForm(routineToForm(response.routine))
      setProseSource(response.routine)
      setProseDraft(null)
      setProseKey((key) => key + 1)
    } catch (restoreError) {
      setError(getApiErrorMessage(restoreError, 'Failed to restore routine.'))
    } finally {
      setIsSaving(false)
    }
  }

  const updateForm = (updater: (current: RoutineFormState) => RoutineFormState) => {
    setForm((current) => current ? updater(current) : current)
  }

  return (
    <div className="space-y-5 rounded-lg border border-border bg-card/95 p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Button type="button" variant="ghost" className="-ml-3 mb-2 h-8 px-3 text-muted-foreground" onClick={() => router.push(listHref)}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to routines
          </Button>
          <h3 className="text-sm font-semibold text-foreground">
            {editingRoutine ? `${isReadOnly ? 'View' : 'Edit'} ${editingRoutine.name}` : 'Create routine'}
          </h3>
          {editingRoutine ? (
            <p className="text-xs text-muted-foreground">
              {routineStatusLabel(editingRoutine.status)} v{editingRoutine.version}
              {isReadOnly ? ' (read-only)' : ''}
            </p>
          ) : null}
        </div>
        {validation?.ok ? (
          <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            Validation passed
          </p>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      {isLoading || !form ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          Loading routine...
        </div>
      ) : (
        <RoutineSkillCatalogProvider agentId={agentId}>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
            <div className="space-y-1">
              <Label htmlFor="routineName">Name</Label>
              <Input
                id="routineName"
                value={draftHeader.name}
                onChange={(event) => setDraftHeader((current) => ({ ...current, name: event.target.value }))}
                disabled={isReadOnly}
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
                disabled={isReadOnly}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="routineReentryMode">Reentry</Label>
              <Select
                value={draftHeader.activation.reentryMode}
                disabled={isReadOnly}
                onValueChange={(value) => setDraftHeader((current) => ({
                  ...current,
                  activation: { ...current.activation, reentryMode: value as RoutineReentryMode },
                }))}
              >
                <SelectTrigger id="routineReentryMode" aria-label="Routine reentry policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REENTRY_MODE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {REENTRY_MODE_OPTIONS.find((option) => option.value === draftHeader.activation.reentryMode)?.hint}
              </p>
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
                disabled={isReadOnly}
              />
            </div>
          </div>
          <RoutineDiagnosticList diagnostics={routineDiagnostics} />

          <Tabs value={viewMode} onValueChange={(value) => synchronizeView(value as 'prose' | 'form')}>
            <TabsList aria-label="Routine editor view">
              {/* The chip editor has no read-only mode; a published/archived routine
                  is viewed in the (disabled) Form tab rather than an editable prose surface. */}
              <TabsTrigger value="prose" disabled={isReadOnly}>
                <Sparkles className="h-4 w-4" />
                Prose
              </TabsTrigger>
              <TabsTrigger value="form">
                <FormInput className="h-4 w-4" />
                Form
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {viewMode === 'prose' && proseSource ? (
            <RoutineProseTab
              key={proseKey}
              source={proseSource}
              header={draftHeader}
              onDraftChange={setProseDraft}
              onHeaderChange={setDraftHeader}
            />
          ) : null}

          {viewMode === 'form' ? (
            <RoutineFormEditor
              form={form}
              diagnostics={validationDiagnostics}
              isPublished={isReadOnly}
              slotKeys={slotKeys}
              webhookDestinations={webhookDestinations}
              isWebhookDestinationsLoading={isWebhookDestinationsLoading}
              webhookDestinationsError={webhookDestinationsError}
              emailSkills={emailSkills}
              onChange={updateForm}
            />
          ) : null}

          {versionHistory.length > 0 ? (
            <div className="rounded-lg border border-border p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
                <History className="h-4 w-4 text-muted-foreground" />
                Version history
              </div>
              <div className="space-y-2">
                {versionHistory.map((version) => (
                  <button
                    key={version.id}
                    type="button"
                    className="flex w-full flex-wrap items-center justify-between gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60"
                    onClick={() => router.push(buildPersistedHref(version.id))}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">v{version.version}</span>
                      <Badge variant="outline">{routineStatusLabel(version.status)}</Badge>
                      {version.id === editingRoutine?.id ? (
                        <span className="text-xs text-muted-foreground">current view</span>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">{formatRoutineDate(version.updatedAt)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            {editingRoutine?.status === 'draft' ? (
              <Button type="button" variant="ghost" onClick={() => void deleteDraft()} disabled={isSaving} aria-label={`Delete draft ${editingRoutine.name}`}>
                <Trash2 className="mr-2 h-4 w-4" />
                Delete draft
              </Button>
            ) : null}
            {editingRoutine?.status === 'published' ? (
              <>
                <Button type="button" variant="outline" onClick={() => void archivePublished()} disabled={isSaving}>
                  <Archive className="mr-2 h-4 w-4" />
                  Archive
                </Button>
                <Button type="button" onClick={() => void revisePublished()} disabled={isSaving}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit revision
                </Button>
              </>
            ) : null}
            {editingRoutine?.status === 'archived' ? (
              <Button type="button" onClick={() => void restoreArchived()} disabled={isSaving}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Restore
              </Button>
            ) : null}
            {!isReadOnly ? (
              <>
                <Button type="button" variant="outline" onClick={() => void saveDraft()} disabled={isSaving}>
                  Save draft
                </Button>
                <Button type="button" variant="outline" onClick={() => void validateDraft()} disabled={isSaving}>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Validate
                </Button>
                <Button type="button" onClick={() => void publishDraft()} disabled={isSaving}>
                  <Send className="mr-2 h-4 w-4" />
                  Publish
                </Button>
              </>
            ) : null}
          </div>
        </RoutineSkillCatalogProvider>
      )}
    </div>
  )
}
