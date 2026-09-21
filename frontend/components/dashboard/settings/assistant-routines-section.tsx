'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Route, Trash2 } from 'lucide-react'

import { RoutineDiagnosticList } from '@/components/dashboard/settings/routine-editor-controls'
import { RoutineDraftAssistDialog } from '@/components/dashboard/settings/routine-draft-assist-dialog'
import { RoutineCompletionExportPanel } from '@/components/dashboard/settings/routine-completion-export-panel'
import { RoutineMapDialog } from '@/components/dashboard/settings/routine-canvas'
import { RoutineDocumentTab } from '@/components/dashboard/settings/routine-document-tab'
import { RoutineEditorHeader, type RoutineValidationStatus } from '@/components/dashboard/settings/routine-editor-header'
import { RoutineSkillCatalogProvider } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { useRegisterRoutineHeader } from '@/components/dashboard/shared/routine-header-actions'
import { useRoutineEnabledToggle } from '@/hooks/use-routine-enabled-toggle'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { getApiErrorMessage } from '@/lib/api-error'
import { agentSectionRoute } from '@/lib/dashboard-areas'
import { buildAgentSectionHref, buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import {
  routinesApi,
  webhookDestinationsApi,
  type RoutineDefinition,
  type RoutineDefinitionDraft,
  type RoutineValidationResult,
  type WebhookDestination,
} from '@/lib/api'
import {
  formToRoutineDraft,
  renderedDraftTargets,
  routineLevelDiagnostics,
  buildCompletionExportPayloadPreview,
  routineContentUpdatePayload,
  routineToForm,
  type RoutineDraftHeader,
  type RoutineFormState,
} from '@/lib/routine-form'
import { useCopilotEntity } from '@/lib/copilot-context'

// A stable no-op: the editor's own toggle supplies request-scoped callbacks per call instead
// (see `toggleRoutineEnabled` below), so `useRoutineEnabledToggle`'s defaults never fire here.
// A fresh arrow function on every render would do just as well functionally, but it would
// also change identity every render, which — now that the header action memo below depends on
// the toggle — would recompute the routine header every render and loop the header-registration
// effect that mirrors it into the page shell.
const noop = () => {}

function CopilotRoutineEntity({ routine }: { routine: RoutineDefinition }) {
  useCopilotEntity('routine', routine.id, routine.name || 'Untitled routine')
  return null
}

// A blank routine starts with its one visible step flowing to completion. The Document tab
// hides this ordinary default edge, but the backend needs the real graph when an author saves
// a single-step routine.
const emptyRoutineDraft = (): RoutineDefinitionDraft => ({
  name: '',
  activation: { triggerDescription: '', gateRef: null, priority: 0 },
  slots: [],
  steps: [{ stableStepId: 'step_1', kind: 'chat', instruction: '', toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: 'step_1', toRef: 'complete', guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 }],
  terminals: [{ stableStepId: 'complete', kind: 'complete', instruction: 'Confirm completion.', ordinal: 0 }],
})

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
  if (draft.steps.some((step) => (step.options ?? []).some((option) => !option.label.trim()))) {
    return 'Each approval option needs a label.'
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
  enabled: draft.enabled ?? routine?.enabled ?? true,
  createdAt: routine?.createdAt ?? new Date(0).toISOString(),
  updatedAt: routine?.updatedAt ?? new Date(0).toISOString(),
})

const headerFromDraft = (draft: RoutineDefinitionDraft | RoutineDefinition | RoutineFormState): RoutineDraftHeader => ({
  name: draft.name,
  enabled: draft.enabled ?? true,
  activation: {
    triggerDescription: draft.activation.triggerDescription,
    priority: String(draft.activation.priority),
    reentryMode: draft.activation.reentryMode ?? 'once_per_conversation',
    coverageCriteria: draft.activation.coverageCriteria,
  },
})

const draftWithHeader = (draft: RoutineDefinitionDraft, header: RoutineDraftHeader): RoutineDefinitionDraft => ({
  ...draft,
  name: header.name.trim(),
  enabled: header.enabled,
  activation: {
    ...draft.activation,
    triggerDescription: header.activation.triggerDescription.trim(),
    priority: Number.parseInt(header.activation.priority, 10) || 0,
    reentryMode: header.activation.reentryMode,
    coverageCriteria: header.activation.coverageCriteria,
  },
})

const mergeDocumentHeaderChange = (
  nextDraft: RoutineDefinitionDraft,
  previousDraft: RoutineDefinitionDraft | null,
  currentHeader: RoutineDraftHeader,
): RoutineDefinitionDraft => {
  // Before the first emit the document was seeded from the current header state, so the
  // header itself is the baseline; using the emitted draft as its own baseline would make
  // the first edit undetectable and revert it.
  const previousHeader = previousDraft ? headerFromDraft(previousDraft) : currentHeader
  const nextHeader = headerFromDraft(nextDraft)
  return draftWithHeader(nextDraft, {
    // The document has no name editor, so the header always owns the name; comparing the
    // doc-emitted name would wipe a typed name with the seed's empty string. Enabled state is
    // never part of the document's own content either, so it always carries forward untouched.
    name: currentHeader.name,
    enabled: currentHeader.enabled,
    activation: {
      triggerDescription: nextHeader.activation.triggerDescription !== previousHeader.activation.triggerDescription
        ? nextHeader.activation.triggerDescription
        : currentHeader.activation.triggerDescription,
      priority: nextHeader.activation.priority !== previousHeader.activation.priority
        ? nextHeader.activation.priority
        : currentHeader.activation.priority,
      reentryMode: nextHeader.activation.reentryMode !== previousHeader.activation.reentryMode
        ? nextHeader.activation.reentryMode
        : currentHeader.activation.reentryMode,
      coverageCriteria: nextHeader.activation.coverageCriteria,
    },
  })
}

const currentBrowserUrlMatches = (href: string) =>
  typeof window !== 'undefined' && `${window.location.pathname}${window.location.search}` === href

type NewRoutineRecovery = {
  draft: RoutineDefinitionDraft
  header: RoutineDraftHeader
}

const newRoutineRecoveryKey = (agentId: string) => `radioso:routine-new-draft:${agentId}`

const readNewRoutineRecovery = (agentId: string): NewRoutineRecovery | null => {
  if (typeof window === 'undefined') return null
  const value = window.sessionStorage.getItem(newRoutineRecoveryKey(agentId))
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<NewRoutineRecovery>
    if (!parsed.draft || !parsed.header) return null
    return { draft: parsed.draft, header: parsed.header }
  } catch {
    return null
  }
}

const writeNewRoutineRecovery = (agentId: string, recovery: NewRoutineRecovery) => {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(newRoutineRecoveryKey(agentId), JSON.stringify(recovery))
}

const clearNewRoutineRecovery = (agentId: string) => {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(newRoutineRecoveryKey(agentId))
}

// Shared by the routine list row and the editor screen — same confirmation, different local
// state backing "which routine, if any, is pending delete". A routine that never went live is
// removed outright; one that did is taken out of service instead, so an in-flight conversation
// resuming it keeps working.
function DeleteRoutineDialog({
  open,
  onOpenChange,
  routineName,
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  routineName: string | undefined
  busy: boolean
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete routine?</AlertDialogTitle>
          <AlertDialogDescription>
            Deletes {routineName ? `"${routineName}"` : 'this routine'} if it has never gone live, otherwise takes it out of service. Customers see the change after Review &amp; Publish.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            Delete routine
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
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
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [deletingRoutine, setDeletingRoutine] = useState<RoutineDefinition | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sortedRoutines = useMemo(
    () => [...routines].sort((left, right) => left.name.localeCompare(right.name)),
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

  useLayoutEffect(() => {
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

  // A routine that has ever served can't be hard-deleted (an in-flight conversation may have
  // pinned it), so the backend disables it in place instead and it stays listed. Refetching
  // rather than filtering locally means the row reflects what the server actually did instead
  // of a "deleted" state the next reload would silently contradict.
  const deleteRoutine = async (routine: RoutineDefinition) => {
    setBusyAction(`delete:${routine.id}`)
    setError(null)
    try {
      await routinesApi.deleteRoutine(agentId, routine.id)
      const response = await routinesApi.listRoutines(agentId)
      setRoutines(response.routines)
      setDeletingRoutine(null)
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete routine.'))
    } finally {
      setBusyAction(null)
    }
  }

  // Whether a routine may activate is one field on the routine, so it goes through the same
  // update path as its content. The row is replaced from the response rather than flipped
  // optimistically, so what the list shows is what the server stored.
  const applyRoutineEnabledToggle = useRoutineEnabledToggle({
    agentId,
    onSuccess: (routine) => setRoutines((current) => current.map((item) => item.id === routine.id ? routine : item)),
    onError: setError,
  })
  const toggleRoutine = async (routine: RoutineDefinition, enabled: boolean) => {
    setBusyAction(`toggle:${routine.id}`)
    setError(null)
    try {
      await applyRoutineEnabledToggle(routine.id, enabled)
    } finally {
      setBusyAction(null)
    }
  }

  const renderRoutineRow = (routine: RoutineDefinition) => (
    <div key={routine.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
      <CopilotRoutineEntity routine={routine} />
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => router.push(buildRoutineHref(routine.id))}
      >
        <p className="text-sm font-medium text-foreground">{routine.name}</p>
        <p className="mt-1 text-xs text-muted-foreground">{routine.activation.triggerDescription}</p>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={routine.enabled}
          onCheckedChange={(enabled) => void toggleRoutine(routine, enabled)}
          disabled={busyAction === `toggle:${routine.id}`}
          aria-label={`Enable ${routine.name}`}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setDeletingRoutine(routine)}
          aria-label={`Delete ${routine.name}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )

  return (
    <SettingsCard
      id="assistant-routines-card"
      icon={<Route className="h-5 w-5 text-primary" />}
      title="Routines"
      description="Multi-step procedures the agent runs to complete a task — collect details, call a skill, then finish or hand off. Reach for a routine when a single directive isn't enough. Routine changes prepare the agent draft; customers get them only after Review & Publish."
      headerEnd={(
        <div className="flex items-center gap-2">
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
        ) : sortedRoutines.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No routines yet.
          </p>
        ) : (
          <div className="space-y-3">
            {sortedRoutines.map(renderRoutineRow)}
          </div>
        )}
      </div>
      <DeleteRoutineDialog
        open={Boolean(deletingRoutine)}
        onOpenChange={(open) => { if (!open) setDeletingRoutine(null) }}
        routineName={deletingRoutine?.name}
        // Scoped to the routine this dialog is actually confirming, not `busyAction` at large —
        // otherwise an unrelated row's in-flight toggle would disable this dialog's buttons too.
        busy={busyAction === `delete:${deletingRoutine?.id}`}
        onConfirm={() => { if (deletingRoutine) void deleteRoutine(deletingRoutine) }}
      />
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
  const [form, setForm] = useState<RoutineFormState | null>(null)
  // The Document tab owns a block document locally, then projects each edit back through
  // draftFromBlockDoc. Keeping that projection here makes save and validate use the same
  // shared draft path as the Form tab.
  const [documentDraft, setDocumentDraft] = useState<RoutineDefinitionDraft | null>(null)
  const [draftHeader, setDraftHeader] = useState<RoutineDraftHeader>(() => headerFromDraft(emptyRoutineDraft()))
  // The Document editor owns its state while mounted; flows that replace the whole draft
  // in place (draft assist) bump this nonce so the editor remounts on the new draft.
  const [documentSessionNonce, setDocumentSessionNonce] = useState(0)
  const [validation, setValidation] = useState<RoutineValidationResult | null>(null)
  const [validatedDraftSignature, setValidatedDraftSignature] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(!isNewRoutine)
  const [isSaving, setIsSaving] = useState(false)
  const [isTogglingEnabled, setIsTogglingEnabled] = useState(false)
  const [isDraftingRoutine, setIsDraftingRoutine] = useState(false)
  const [draftAssistDialogOpen, setDraftAssistDialogOpen] = useState(false)
  const [draftAssistProse, setDraftAssistProse] = useState('')
  const [webhookDestinations, setWebhookDestinations] = useState<WebhookDestination[]>([])
  const [isWebhookDestinationsLoading, setIsWebhookDestinationsLoading] = useState(true)
  const [webhookDestinationsError, setWebhookDestinationsError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleteRoutineDialogOpen, setDeleteRoutineDialogOpen] = useState(false)
  const [mapDialogOpen, setMapDialogOpen] = useState(false)
  const currentRoutineIdRef = useRef<string | null>(null)
  const isTogglingEnabledRef = useRef(false)
  const pendingRoutineToggleRef = useRef<{ routineId: string; previousEnabled: boolean } | null>(null)
  const initializedRouteKeyRef = useRef<string | null>(null)
  const { beginSave, isCurrentSave, markError, markSaved } = useSettingsSaveStatus(onSaveStateChange)
  useCopilotEntity(
    'routine',
    isNewRoutine ? null : routineRouteId,
    editingRoutine?.name || 'Routine editor',
    true,
  )

  const listHref = buildDashboardHref(accountId, {
    section: 'agents',
    workspaceId: routeState.workspaceId,
    workspacePublicRouteKey: routeState.workspacePublicRouteKey,
    agentId,
    agentRoutineId: undefined,
    agentTab: 'behavior',
    anchor: 'assistant-routines',
  })

  // The draft revision snapshot carries this routine's draft, so the agent's Test
  // Chat is where it runs: the same private test the rest of the draft gets.
  const testChatHref = buildAgentSectionHref(accountId, routeState, agentId, agentSectionRoute('chat'))

  const buildPersistedHref = (routineId: string) =>
    buildDashboardHref(accountId, {
      ...routeState,
      section: 'agents',
      agentId,
      agentRoutineId: routineId,
      agentTab: undefined,
      anchor: undefined,
    })

  const activeRoutineDraft = useMemo(() => {
    if (documentDraft) return draftWithHeader(documentDraft, draftHeader)
    return form ? formToRoutineDraft(form, { header: draftHeader }) : null
  }, [documentDraft, draftHeader, form])
  const activeRoutineDraftSignature = useMemo(
    () => activeRoutineDraft ? JSON.stringify(activeRoutineDraft) : null,
    [activeRoutineDraft],
  )
  const activeRoutineDraftError = useMemo(
    () => {
      return activeRoutineDraft ? draftError(activeRoutineDraft) : 'Routine draft is not ready.'
    },
    [activeRoutineDraft],
  )
  const nameLocalValidationError = !draftHeader.name.trim() ? 'Name is required.' : null
  const isValidationCurrent = Boolean(activeRoutineDraftSignature && validatedDraftSignature === activeRoutineDraftSignature)
  const validationStatus: RoutineValidationStatus = activeRoutineDraftError || (isValidationCurrent && validation && !validation.ok)
    ? 'invalid'
    : isValidationCurrent && validation?.ok
      ? 'valid'
      : 'checking'
  const validationDiagnostics = useMemo(
    () => isValidationCurrent ? validation?.diagnostics ?? [] : [],
    [isValidationCurrent, validation?.diagnostics],
  )
  // The Form editor anchors a diagnostic list against each artifact it renders; the Document
  // editor renders none of them. Whatever is left over — a genuinely routine-scoped
  // diagnostic, one naming an artifact this view does not show, or one in a location form
  // the editor has no site for — surfaces here, so no diagnostic stays invisible (FR-030).
  const renderedFormTargets = useMemo(
    () => activeRoutineDraft ? renderedDraftTargets(activeRoutineDraft) : [],
    [activeRoutineDraft],
  )
  const routineDiagnostics = useMemo(
    () => routineLevelDiagnostics(validationDiagnostics, renderedFormTargets),
    [renderedFormTargets, validationDiagnostics],
  )

  useEffect(() => {
    currentRoutineIdRef.current = editingRoutine?.id ?? null
  }, [editingRoutine?.id])

  useEffect(() => {
    let active = true
    // A response from the routine being left must not replace this editor's newly loaded
    // routine or roll back its header. The pending request still completes server-side, but
    // it no longer owns this route's local state.
    pendingRoutineToggleRef.current = null
    isTogglingEnabledRef.current = false
    queueMicrotask(() => {
      if (!active) return
      setIsTogglingEnabled(false)
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
      if (!active) return
      if (routineRouteId !== 'new' && currentRoutineIdRef.current === routineRouteId) {
        setIsLoading(false)
        return
      }

      setValidation(null)
      setValidatedDraftSignature(null)
      setError(null)

      if (routineRouteId === 'new') {
        const routeLoadKey = `${agentId}:${routineRouteId}`
        if (initializedRouteKeyRef.current === routeLoadKey) {
          setIsLoading(false)
          return
        }
        const recovered = readNewRoutineRecovery(agentId)
        const nextDraft = recovered?.draft ?? emptyRoutineDraft()
        const nextHeader = recovered?.header ?? headerFromDraft(nextDraft)
        currentRoutineIdRef.current = null
        initializedRouteKeyRef.current = routeLoadKey
        setEditingRoutineId(null)
        setEditingRoutine(null)
        setDraftHeader(nextHeader)
        setForm(routineToForm(draftAsRoutine(nextDraft)))
        setDocumentDraft(null)
        setIsLoading(false)
        return
      }

      currentRoutineIdRef.current = null
      initializedRouteKeyRef.current = `${agentId}:${routineRouteId}`
      setEditingRoutineId(routineRouteId)
      setEditingRoutine(null)
      setForm(null)
      setDocumentDraft(null)
      setIsLoading(true)
      void routinesApi.getRoutine(agentId, routineRouteId)
        .then((response) => {
          if (!active) return
          currentRoutineIdRef.current = response.routine.id
          setEditingRoutine(response.routine)
          setEditingRoutineId(response.routine.id)
          setDraftHeader(headerFromDraft(response.routine))
          setForm(routineToForm(response.routine))
          setDocumentDraft(null)
          setValidatedDraftSignature(null)
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

  const saveDraft = async ({ refreshEditor = true }: { refreshEditor?: boolean } = {}): Promise<RoutineDefinition | null> => {
    const draft = activeRoutineDraft
    if (!draft) return null
    const errorMessage = activeRoutineDraftError ?? draftError(draft)
    if (errorMessage) {
      setError(errorMessage)
      setValidatedDraftSignature(null)
      return null
    }
    const draftSignature = JSON.stringify(draft)
    const saveId = beginSave()
    const wasNew = !editingRoutineId
    setIsSaving(true)
    setError(null)
    try {
      // The update branch never sends `enabled`: the enable/disable toggle
      // (toggleRoutineEnabled) is this field's only writer, so a content autosave that also
      // carried a copy of it could race that toggle's own PATCH and overwrite it with a stale
      // value regardless of which request the operator triggered second. A brand-new routine
      // has no stored value to preserve, so create still sends whatever the header holds.
      const response = editingRoutineId
        ? await routinesApi.updateRoutine(agentId, editingRoutineId, routineContentUpdatePayload(draft))
        : await routinesApi.createRoutine(agentId, draft)
      if (!isCurrentSave(saveId)) return null
      currentRoutineIdRef.current = response.routine.id
      setEditingRoutine(response.routine)
      setEditingRoutineId(response.routine.id)
      if (refreshEditor) {
        setDraftHeader(headerFromDraft(response.routine))
        setForm(routineToForm(response.routine))
        setDocumentDraft(null)
      }
      setValidation(response.validation)
      setValidatedDraftSignature(draftSignature)
      markSaved()
      if (wasNew) {
        clearNewRoutineRecovery(agentId)
        // A raw history replacement leaves `routineRouteId === 'new'` mounted, so its
        // recovery effect writes the just-created draft back into session storage. Route
        // through Next instead: the persisted editor replaces the new-draft screen.
        if (currentBrowserUrlMatches(buildPersistedHref('new'))) {
          router.replace(buildPersistedHref(response.routine.id))
        }
      }
      return response.routine
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return null
      const message = getApiErrorMessage(saveError, 'Failed to save routine draft.')
      setValidatedDraftSignature(null)
      setError(message)
      markError(message)
      return null
    } finally {
      if (isCurrentSave(saveId)) setIsSaving(false)
    }
  }

  const saveDraftRef = useRef(saveDraft)
  useEffect(() => {
    saveDraftRef.current = saveDraft
  })

  // Tracked so a navigation-triggered flush (see flushPendingSave below) can cancel the
  // scheduled autosave instead of racing it.
  const pendingAutosaveTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    if (isLoading || activeRoutineDraftError || !activeRoutineDraftSignature || isValidationCurrent) return
    const timeoutId = window.setTimeout(() => {
      pendingAutosaveTimeoutRef.current = null
      void saveDraftRef.current({ refreshEditor: false })
    }, 1500)
    pendingAutosaveTimeoutRef.current = timeoutId
    return () => {
      window.clearTimeout(timeoutId)
      if (pendingAutosaveTimeoutRef.current === timeoutId) pendingAutosaveTimeoutRef.current = null
    }
  }, [activeRoutineDraftError, activeRoutineDraftSignature, isLoading, isValidationCurrent])

  // Test draft navigates away, which unmounts this section and cancels the debounce above.
  // Flush any unsaved edit into the same saveDraft the timer would have called so the draft
  // under test always reflects the operator's last keystroke.
  const flushPendingSave = useCallback(async (): Promise<boolean> => {
    const hasPendingChange = !isValidationCurrent && !activeRoutineDraftError && Boolean(activeRoutineDraftSignature)
    if (!hasPendingChange) return true
    if (pendingAutosaveTimeoutRef.current !== null) {
      window.clearTimeout(pendingAutosaveTimeoutRef.current)
      pendingAutosaveTimeoutRef.current = null
    }
    const saved = await saveDraftRef.current({ refreshEditor: false })
    return saved !== null
  }, [activeRoutineDraftError, activeRoutineDraftSignature, isValidationCurrent])

  const handleTestDraft = useCallback(() => {
    void (async () => {
      if (await flushPendingSave()) {
        router.push(testChatHref)
      }
    })()
  }, [flushPendingSave, router, testChatHref])

  useEffect(() => {
    if (!isNewRoutine || !activeRoutineDraft) return
    writeNewRoutineRecovery(agentId, { draft: activeRoutineDraft, header: draftHeader })
  }, [activeRoutineDraft, agentId, draftHeader, isNewRoutine])

  // Mirrors the list row's switch: takes effect immediately for a saved routine, rather than
  // waiting on the autosave debounce that owns the rest of the form.
  const applyRoutineEnabledToggle = useRoutineEnabledToggle({
    agentId,
    // The editor supplies request-scoped callbacks below. List rows use the default callbacks
    // directly because their state lives in one collection rather than a routed editor.
    onSuccess: noop,
    onError: noop,
  })
  const toggleRoutineEnabled = useCallback(async (enabled: boolean) => {
    // The ref closes the small gap before React has rendered the disabled switch. Without it,
    // two discrete events could still start overlapping PATCHes and let the older response win.
    if (isTogglingEnabledRef.current) return
    setDraftHeader((current) => ({ ...current, enabled }))
    if (!editingRoutineId) return
    setError(null)
    const pending = { routineId: editingRoutineId, previousEnabled: draftHeader.enabled }
    pendingRoutineToggleRef.current = pending
    isTogglingEnabledRef.current = true
    setIsTogglingEnabled(true)
    try {
      await applyRoutineEnabledToggle(editingRoutineId, enabled, {
        onSuccess: (routine) => {
          if (pendingRoutineToggleRef.current !== pending || currentRoutineIdRef.current !== routine.id) return
          setEditingRoutine(routine)
        },
        onError: (message) => {
          if (pendingRoutineToggleRef.current !== pending || currentRoutineIdRef.current !== pending.routineId) return
          setError(message)
          setDraftHeader((current) => ({ ...current, enabled: pending.previousEnabled }))
        },
      })
    } finally {
      if (pendingRoutineToggleRef.current === pending) {
        pendingRoutineToggleRef.current = null
        isTogglingEnabledRef.current = false
        setIsTogglingEnabled(false)
      }
    }
  }, [applyRoutineEnabledToggle, draftHeader.enabled, editingRoutineId])

  const deleteRoutine = async () => {
    if (!editingRoutine) return
    setIsSaving(true)
    setError(null)
    try {
      await routinesApi.deleteRoutine(agentId, editingRoutine.id)
      router.push(listHref)
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete routine.'))
    } finally {
      setIsSaving(false)
    }
  }

  const loadAssistedDraft = useCallback(async () => {
    const prose = draftAssistProse.trim()
    if (!prose) return
    setIsDraftingRoutine(true)
    setError(null)
    try {
      const response = await routinesApi.draftRoutineFromProcedure(agentId, { prose })
      const nextHeader = headerFromDraft(response.draft)
      const nextSignature = JSON.stringify(response.draft)
      setDraftHeader(nextHeader)
      setForm(routineToForm(draftAsRoutine(response.draft, editingRoutine)))
      setValidation(response.validation)
      setValidatedDraftSignature(nextSignature)
      setDocumentDraft(null)
      setDocumentSessionNonce((nonce) => nonce + 1)
      setDraftAssistDialogOpen(false)
    } catch (draftError) {
      setError(getApiErrorMessage(draftError, 'Failed to draft routine from procedure.'))
    } finally {
      setIsDraftingRoutine(false)
    }
  }, [agentId, draftAssistProse, editingRoutine])

  const openDeleteRoutineDialog = useCallback(() => setDeleteRoutineDialogOpen(true), [])
  const actionHandlersRef = useRef({ loadAssistedDraft, openDeleteRoutineDialog })
  useEffect(() => {
    actionHandlersRef.current = { loadAssistedDraft, openDeleteRoutineDialog }
  })

  // A disabled routine is left out of the draft snapshot's activation set, so a draft test
  // could never reach it.
  const canTestDraft = draftHeader.enabled
  const isPersisted = Boolean(editingRoutine)
  const onNameChange = useCallback((name: string) => setDraftHeader((current) => ({ ...current, name })), [])
  const onToggleEnabled = useCallback(() => void toggleRoutineEnabled(!draftHeader.enabled), [draftHeader.enabled, toggleRoutineEnabled])
  const onOpenMap = useMemo(() => activeRoutineDraft ? () => setMapDialogOpen(true) : undefined, [activeRoutineDraft])
  const onOpenDraftAssist = useCallback(() => setDraftAssistDialogOpen(true), [])
  const onBack = useCallback(() => router.push(listHref), [listHref, router])
  // One shared prop bag so the title and actions halves below — two separate elements,
  // because the page shell's header registers them into two separate slots — can never drift
  // out of sync with each other's view of the routine.
  const headerProps = useMemo(() => ({
    name: draftHeader.name,
    onNameChange,
    enabled: draftHeader.enabled,
    onToggleEnabled,
    isToggling: isTogglingEnabled,
    canTest: canTestDraft,
    onTest: handleTestDraft,
    isPersisted,
    isSaving,
    isDrafting: isDraftingRoutine,
    validationStatus,
    onOpenMap,
    onOpenDraftAssist,
    // `openDeleteRoutineDialog` is already a permanently stable `useCallback` ([] deps), so it
    // can sit directly in this bag without the ref indirection `loadAssistedDraft` needs
    // elsewhere in this file — that trick is for keeping an *unstable* callback's identity out
    // of a memo's deps, which doesn't apply here.
    onDelete: openDeleteRoutineDialog,
    onBack,
    showActions: Boolean(form),
  }), [canTestDraft, draftHeader.enabled, draftHeader.name, form, handleTestDraft, isDraftingRoutine, isPersisted, isSaving, isTogglingEnabled, onBack, onNameChange, onOpenDraftAssist, onOpenMap, onToggleEnabled, openDeleteRoutineDialog, validationStatus])
  const routineHeaderTitle = useMemo(() => <RoutineEditorHeader slot="title" {...headerProps} />, [headerProps])
  const routineHeaderActions = useMemo(() => <RoutineEditorHeader slot="actions" {...headerProps} />, [headerProps])

  const routineHeader = useMemo(() => ({
    actions: routineHeaderActions,
    backAction: null,
    // Loading has its own inline spinner in the body; the header itself carries no subtitle
    // once the routine is ready to show — `undefined` (not `null`) is reserved for "nothing
    // registered a header yet" (see `emptyRoutineHeader`), so this section always registers
    // one or the other explicitly rather than leaving the page shell to guess.
    description: isLoading || !form ? undefined : null,
    title: routineHeaderTitle,
  }), [form, isLoading, routineHeaderActions, routineHeaderTitle])

  useRegisterRoutineHeader(routineHeader)

  return (
    <>
      <RoutineDraftAssistDialog
        isOpen={draftAssistDialogOpen}
        isDrafting={isDraftingRoutine}
        prose={draftAssistProse}
        onOpenChange={setDraftAssistDialogOpen}
        onProseChange={setDraftAssistProse}
        onLoadProposal={() => void actionHandlersRef.current.loadAssistedDraft()}
      />
      <div className="space-y-5">
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          {isLoading || !form ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" />
              Loading routine...
            </div>
          ) : (
            <RoutineSkillCatalogProvider agentId={agentId}>
            {nameLocalValidationError ? <p className="text-xs text-destructive" role="status">{nameLocalValidationError}</p> : null}
            <RoutineDiagnosticList diagnostics={routineDiagnostics} />
            {activeRoutineDraft ? (
              <RoutineMapDialog draft={activeRoutineDraft} open={mapDialogOpen} onOpenChange={setMapDialogOpen} />
            ) : null}

            {activeRoutineDraft ? (
              <RoutineDocumentTab
                key={`${agentId}:${routineRouteId}:${documentSessionNonce}`}
                draft={activeRoutineDraft}
                diagnostics={validationDiagnostics}
                onDraftChange={(nextDraft) => {
                  // Completion export is edited in the panel below, not in the document, so
                  // a document emission must not revert a panel change it never saw.
                  const mergedDraft = {
                    ...mergeDocumentHeaderChange(nextDraft, documentDraft, draftHeader),
                    ...(documentDraft?.completionExport !== undefined ? { completionExport: documentDraft.completionExport } : {}),
                  }
                  setDocumentDraft(mergedDraft)
                  setForm(routineToForm(draftAsRoutine(mergedDraft, editingRoutine)))
                  setDraftHeader(headerFromDraft(mergedDraft))
                }}
                // Rendered inside the document's own "Details" disclosure, alongside Endings
                // and Collected information, rather than as a card of its own below it.
                detailsExtra={(
                  <RoutineCompletionExportPanel
                    idPrefix="document-completion-export"
                    payloadPreview={form ? buildCompletionExportPayloadPreview(form) : undefined}
                    value={activeRoutineDraft.completionExport ?? { enabled: false, triggerKinds: [], destinationRef: '' }}
                    onChange={(next) => {
                      const merged = { ...(documentDraft ?? activeRoutineDraft), completionExport: next }
                      setDocumentDraft(merged)
                      setForm(routineToForm(draftAsRoutine(merged, editingRoutine)))
                    }}
                    webhookDestinations={webhookDestinations}
                    isLoading={isWebhookDestinationsLoading}
                    error={webhookDestinationsError}
                  />
                )}
              />
            ) : null}

            </RoutineSkillCatalogProvider>
          )}
      </div>
      <DeleteRoutineDialog
        open={deleteRoutineDialogOpen}
        onOpenChange={setDeleteRoutineDialogOpen}
        routineName={editingRoutine?.name}
        busy={isSaving}
        onConfirm={() => void deleteRoutine()}
      />
    </>
  )
}
