'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Archive,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Eye,
  FileText,
  FlaskConical,
  FormInput,
  History,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Route,
  Send,
  Trash2,
  WandSparkles,
} from 'lucide-react'

import { ChatWorkbenchDrawer } from '@/components/dashboard/workbench/chat-workbench-drawer'
import { RoutineDiagnosticList } from '@/components/dashboard/settings/routine-editor-controls'
import { RoutineDraftAssistDialog } from '@/components/dashboard/settings/routine-draft-assist-dialog'
import { RoutineCompletionExportPanel } from '@/components/dashboard/settings/routine-completion-export-panel'
import { RoutineFormEditor } from '@/components/dashboard/settings/routine-form-editor'
import { RoutineDocumentTab } from '@/components/dashboard/settings/routine-document-tab'
import { RoutineSkillCatalogProvider } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { RoutineVersionHistoryDrawer } from '@/components/dashboard/settings/routine-version-history-drawer'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { useRegisterRoutineHeader } from '@/components/dashboard/shared/routine-header-actions'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
  formToRoutineDraft,
  renderedDiagnosticTargets,
  renderedDraftTargets,
  routineLevelDiagnostics,
  routineToForm,
  type RoutineDraftHeader,
  type RoutineFormState,
} from '@/lib/routine-form'
import { routineToBlockDoc } from '@/lib/routine-prose'
import { useCopilotEntity } from '@/lib/copilot-context'

function CopilotRoutineEntity({ routine }: { routine: RoutineDefinition }) {
  useCopilotEntity('routine', routine.id, routine.name || 'Untitled routine')
  return null
}

// A blank routine for the Form tab: one empty step the author fills in, no transitions
// yet, and a single complete terminal. The Document tab replaces the seed step when the
// author adds their first real one.
const emptyRoutineDraft = (): RoutineDefinitionDraft => ({
  name: '',
  activation: { triggerDescription: '', gateRef: null, priority: 0 },
  slots: [],
  steps: [{ stableStepId: 'step_1', kind: 'chat', instruction: '', toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
  transitions: [],
  terminals: [{ stableStepId: 'complete', kind: 'complete', instruction: 'Confirm completion.', ordinal: 0 }],
})

function RoutineValidationStatusIcon({
  state,
}: {
  state: 'checking' | 'invalid' | 'valid'
}) {
  const label = state === 'valid'
    ? 'Routine valid'
    : state === 'invalid'
      ? 'Routine has validation issues'
      : 'Checking routine'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-label={label}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground"
        >
          {state === 'valid' ? <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" /> : null}
          {state === 'invalid' ? <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" /> : null}
          {state === 'checking' ? <Spinner className="h-4 w-4" /> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

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

// The projection takes authoring drafts; a persisted definition carries extra identity
// fields the strict editing schema rejects, so pick the draft subset before projecting.
const definitionToDraft = (routine: RoutineDefinition): RoutineDefinitionDraft => ({
  name: routine.name,
  activation: routine.activation,
  slots: routine.slots,
  steps: routine.steps,
  transitions: routine.transitions,
  terminals: routine.terminals,
  ...(routine.completionExport ? { completionExport: routine.completionExport } : {}),
})

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

const draftWithHeader = (draft: RoutineDefinitionDraft, header: RoutineDraftHeader): RoutineDefinitionDraft => ({
  ...draft,
  name: header.name.trim(),
  activation: {
    ...draft.activation,
    triggerDescription: header.activation.triggerDescription.trim(),
    priority: Number.parseInt(header.activation.priority, 10) || 0,
    reentryMode: header.activation.reentryMode,
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
    // doc-emitted name would wipe a typed name with the seed's empty string.
    name: currentHeader.name,
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
    },
  })
}

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

const replaceBrowserUrl = (href: string) => {
  if (typeof window === 'undefined') return
  window.history.replaceState(window.history.state, '', href)
}

const currentBrowserUrlMatches = (href: string) => {
  if (typeof window === 'undefined') return false
  return `${window.location.pathname}${window.location.search}` === href
}

type NewRoutineRecovery = {
  draft: RoutineDefinitionDraft
  header: RoutineDraftHeader
  viewMode: 'document' | 'form'
}

const newRoutineRecoveryKey = (agentId: string) => `radioso:routine-new-draft:${agentId}`

const readNewRoutineRecovery = (agentId: string): NewRoutineRecovery | null => {
  if (typeof window === 'undefined') return null
  const value = window.sessionStorage.getItem(newRoutineRecoveryKey(agentId))
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<NewRoutineRecovery>
    if (!parsed.draft || !parsed.header) return null
    // Recoveries written before the Prose tab retired map onto the Document view.
    const viewMode = parsed.viewMode === 'form' ? 'form' : 'document'
    return {
      draft: parsed.draft,
      header: parsed.header,
      viewMode,
    }
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

  const archiveRoutine = async (lineage: RoutineLineageGroup) => {
    const published = lineage.activeRoutine
    if (!published || published.status !== 'published') return
    setError(null)
    try {
      const response = await routinesApi.archiveRoutine(agentId, published.id)
      // Archiving retires the routine and discards any pending revision draft server-side;
      // drop that draft from the list too so the lineage collapses to its archived version.
      const pendingDraftId = lineage.pendingDraft?.id
      setRoutines((current) => [
        ...current.filter((item) => item.id !== response.routine.id && item.id !== pendingDraftId),
        response.routine,
      ])
    } catch (archiveError) {
      setError(getApiErrorMessage(archiveError, 'Failed to archive routine.'))
    }
  }

  const renderLineageRow = (lineage: RoutineLineageGroup) => {
    const routine = lineage.displayRoutine
    const activeVersion = lineage.activeRoutine?.version ?? routine.version
    return (
      <div key={lineage.lineageId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
        <CopilotRoutineEntity routine={routine} />
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
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => void reviseRoutine(routine)} aria-label={`Edit ${routine.name}`}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void archiveRoutine(lineage)} aria-label={`Archive ${routine.name}`}>
                <Archive className="h-4 w-4" />
              </Button>
            </>
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

  return (
    <SettingsCard
      id="assistant-routines-card"
      icon={<Route className="h-5 w-5 text-primary" />}
      title="Routines"
      description="Multi-step procedures the agent runs to complete a task — collect details, call a skill, then finish or hand off. Reach for a routine when a single directive isn't enough."
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
  // The Document tab owns a block document locally, then projects each edit back through
  // draftFromBlockDoc. Keeping that projection here makes save/validate/publish use the
  // same shared draft path as the Form tab.
  const [documentDraft, setDocumentDraft] = useState<RoutineDefinitionDraft | null>(null)
  const [draftHeader, setDraftHeader] = useState<RoutineDraftHeader>(() => headerFromDraft(emptyRoutineDraft()))
  const [viewMode, setViewMode] = useState<'document' | 'form'>('document')
  // The Document editor owns its state while mounted; flows that replace the whole draft
  // in place (draft assist) bump this nonce so the editor remounts on the new draft.
  const [documentSessionNonce, setDocumentSessionNonce] = useState(0)
  const [validation, setValidation] = useState<RoutineValidationResult | null>(null)
  const [validatedDraftSignature, setValidatedDraftSignature] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(!isNewRoutine)
  const [isSaving, setIsSaving] = useState(false)
  // Publish, revise, archive, and restore each move the routine to a status the editor
  // cannot save into. They take a round trip, and `editingRoutine` only catches up when it
  // returns, so autosave has to be told to hold rather than inferring it from status.
  const [isLifecycleBusy, setIsLifecycleBusy] = useState(false)
  const [isDraftingRoutine, setIsDraftingRoutine] = useState(false)
  const [draftAssistDialogOpen, setDraftAssistDialogOpen] = useState(false)
  const [draftAssistProse, setDraftAssistProse] = useState('')
  const [webhookDestinations, setWebhookDestinations] = useState<WebhookDestination[]>([])
  const [isWebhookDestinationsLoading, setIsWebhookDestinationsLoading] = useState(true)
  const [webhookDestinationsError, setWebhookDestinationsError] = useState<string | null>(null)
  const [emailSkills, setEmailSkills] = useState<CustomerEmailSkillDefinition[]>([])
  const [error, setError] = useState<string | null>(null)
  const [deleteDraftDialogOpen, setDeleteDraftDialogOpen] = useState(false)
  const [testDrawerOpen, setTestDrawerOpen] = useState(false)
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false)
  const currentRoutineIdRef = useRef<string | null>(null)
  const initializedRouteKeyRef = useRef<string | null>(null)
  const routineEditorDirtyRef = useRef(false)
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
  const isReadOnly = editingRoutine ? editingRoutine.status !== 'draft' : false
  const versionHistory = useMemo(
    () => getRoutineLineageVersions(allRoutines, editingRoutine?.lineageId),
    [allRoutines, editingRoutine?.lineageId],
  )
  const publishedSibling = useMemo(
    () => versionHistory.find((version) => version.status === 'published') ?? null,
    [versionHistory],
  )
  const activeRoutineDraft = useMemo(() => {
    if (viewMode === 'document' && documentDraft) return draftWithHeader(documentDraft, draftHeader)
    return form ? formToRoutineDraft(form, { header: draftHeader }) : null
  }, [documentDraft, draftHeader, form, viewMode])
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
  const validationStatus = activeRoutineDraftError || (isValidationCurrent && validation && !validation.ok)
    ? 'invalid'
    : isValidationCurrent && validation?.ok
      ? 'valid'
      : 'checking'
  const canPublishDraft = !isReadOnly && Boolean(form && isValidationCurrent && validation?.ok)
  const validationDiagnostics = useMemo(
    () => isValidationCurrent ? validation?.diagnostics ?? [] : [],
    [isValidationCurrent, validation?.diagnostics],
  )
  // The Form editor anchors a diagnostic list against each artifact it renders; the Document
  // editor renders none of them. Whatever is left over — a genuinely routine-scoped
  // diagnostic, one naming an artifact this view does not show, or one in a location form
  // the editor has no site for — surfaces here, so no diagnostic can block publish while
  // being invisible (FR-030).
  const renderedFormTargets = useMemo(
    () => {
      if (viewMode === 'form' && form) return renderedDiagnosticTargets(form)
      if (viewMode === 'document' && activeRoutineDraft) return renderedDraftTargets(activeRoutineDraft)
      return []
    },
    [activeRoutineDraft, form, viewMode],
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
        routineEditorDirtyRef.current = false
        setEditingRoutineId(null)
        setEditingRoutine(null)
        setAllRoutines([])
        setDraftHeader(nextHeader)
        setForm(routineToForm(draftAsRoutine(nextDraft)))
        setDocumentDraft(null)
        setViewMode(recovered?.viewMode ?? 'document')
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
          setDocumentDraft(null)
          setValidatedDraftSignature(null)
          routineEditorDirtyRef.current = false
          // Every representable routine opens in the Document view, editable or not: its rest
          // state is the read surface a published version wants. Only a routine the projection
          // cannot express falls back to the Form view, which shows the raw graph.
          setViewMode(routineToBlockDoc(definitionToDraft(response.routine)).ok ? 'document' : 'form')
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

  const synchronizeView = (nextView: 'document' | 'form') => {
    if (nextView === viewMode) return
    if (nextView === 'document' && form) {
      setDocumentDraft(formToRoutineDraft(form, { header: draftHeader }))
    }
    setViewMode(nextView)
  }

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
      const response = editingRoutineId
        ? await routinesApi.updateRoutine(agentId, editingRoutineId, draft)
        : await routinesApi.createRoutine(agentId, draft)
      if (!isCurrentSave(saveId)) return null
      currentRoutineIdRef.current = response.routine.id
      setEditingRoutine(response.routine)
      setEditingRoutineId(response.routine.id)
      mergeLoadedRoutine(response.routine)
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
        const newDraftHref = buildPersistedHref('new')
        if (currentBrowserUrlMatches(newDraftHref)) {
          replaceBrowserUrl(buildPersistedHref(response.routine.id))
        }
      }
      return response.routine
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return null
      const message = getApiErrorMessage(saveError, 'Failed to save routine draft.')
      // The routine left draft while this editor was open — published in another tab, or by
      // someone else. The editor is showing a version that no longer exists, so re-read the
      // routine and let its real status drive the screen instead of leaving a stale draft
      // behind an error the author cannot act on.
      if (editingRoutineId && /only draft routine definitions can be updated/i.test(message)) {
        void reloadEditingRoutine(editingRoutineId)
      }
      setError(message)
      setValidatedDraftSignature(null)
      markError(message)
      return null
    } finally {
      if (isCurrentSave(saveId)) setIsSaving(false)
    }
  }

  // Re-read a routine the editor can no longer save into, so the header, the tab, and the
  // available actions all describe the version that actually exists.
  const reloadEditingRoutine = async (routineId: string) => {
    try {
      const response = await routinesApi.getRoutine(agentId, routineId)
      if (currentRoutineIdRef.current !== routineId) return
      setEditingRoutine(response.routine)
      mergeLoadedRoutine(response.routine)
      setDraftHeader(headerFromDraft(response.routine))
      setForm(routineToForm(response.routine))
      setDocumentDraft(null)
      routineEditorDirtyRef.current = false
    } catch {
      // The save error already says what went wrong; a failed re-read must not replace it.
    }
  }

  const saveDraftRef = useRef(saveDraft)
  useEffect(() => {
    saveDraftRef.current = saveDraft
  })

  useEffect(() => {
    if (isLoading || isReadOnly || isLifecycleBusy || activeRoutineDraftError || !activeRoutineDraftSignature || isValidationCurrent) return
    const timeoutId = window.setTimeout(() => {
      void saveDraftRef.current({ refreshEditor: false })
    }, 1500)
    return () => window.clearTimeout(timeoutId)
  }, [activeRoutineDraftError, activeRoutineDraftSignature, isLifecycleBusy, isLoading, isReadOnly, isValidationCurrent])

  useEffect(() => {
    if (!isNewRoutine || !activeRoutineDraft) return
    writeNewRoutineRecovery(agentId, {
      draft: activeRoutineDraft,
      header: draftHeader,
      viewMode,
    })
  }, [activeRoutineDraft, agentId, draftHeader, isNewRoutine, viewMode])

  const publishDraft = async () => {
    if (!canPublishDraft) return
    setIsLifecycleBusy(true)
    try {
      await runPublish()
    } finally {
      setIsLifecycleBusy(false)
    }
  }

  const runPublish = async () => {
    const routine = await saveDraft()
    if (!routine) return
    beginSave()
    setIsSaving(true)
    setError(null)
    try {
      const response = await routinesApi.publishRoutine(agentId, routine.id)
      // Publishing is a lifecycle transition, not a save competing with other saves: its
      // result is the routine's real status, so a save that started meanwhile must not
      // discard it. Only leaving this routine can.
      if (currentRoutineIdRef.current !== routine.id) return
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
      const persistedHref = buildPersistedHref(response.routine.id)
      if (!currentBrowserUrlMatches(persistedHref)) {
        router.replace(persistedHref)
      }
    } catch (publishError) {
      if (currentRoutineIdRef.current !== routine.id) return
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
      if (currentRoutineIdRef.current === routine.id) setIsSaving(false)
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
    setIsLifecycleBusy(true)
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
      setDocumentDraft(null)
      setValidation(null)
      setValidatedDraftSignature(null)
      markSaved()
      const persistedHref = buildPersistedHref(response.routine.id)
      if (!currentBrowserUrlMatches(persistedHref)) {
        router.replace(persistedHref)
      }
    } catch (reviseError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(reviseError, 'Failed to create routine revision.')
      setError(message)
      markError(message)
    } finally {
      setIsLifecycleBusy(false)
      if (isCurrentSave(saveId)) setIsSaving(false)
    }
  }

  const archivePublished = async () => {
    if (!editingRoutine || editingRoutine.status !== 'published') return
    setIsLifecycleBusy(true)
    setIsSaving(true)
    setError(null)
    try {
      const response = await routinesApi.archiveRoutine(agentId, editingRoutine.id)
      currentRoutineIdRef.current = response.routine.id
      setEditingRoutine(response.routine)
      setEditingRoutineId(response.routine.id)
      setAllRoutines((current) => [
        ...current.filter((item) =>
          item.id !== response.routine.id &&
          !(item.lineageId === response.routine.lineageId && item.status === 'draft')
        ),
        response.routine,
      ])
      setDraftHeader(headerFromDraft(response.routine))
      setForm(routineToForm(response.routine))
      setDocumentDraft(null)
    } catch (archiveError) {
      setError(getApiErrorMessage(archiveError, 'Failed to archive routine.'))
    } finally {
      setIsSaving(false)
      setIsLifecycleBusy(false)
    }
  }

  const archiveFromDraft = async () => {
    if (!publishedSibling) return
    setIsLifecycleBusy(true)
    setIsSaving(true)
    setError(null)
    try {
      // Retire the whole routine from a revision draft without forcing a publish first;
      // the archive discards this pending draft server-side, so return to the list.
      await routinesApi.archiveRoutine(agentId, publishedSibling.id)
      router.push(listHref)
    } catch (archiveError) {
      setError(getApiErrorMessage(archiveError, 'Failed to archive routine.'))
      setIsSaving(false)
      // Only released on failure: a success navigates away from this editor, and releasing
      // the hold on the way out would let a queued autosave fire at the archived routine.
      setIsLifecycleBusy(false)
    }
  }

  const restoreArchived = async () => {
    if (!editingRoutine || editingRoutine.status !== 'archived') return
    setIsLifecycleBusy(true)
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
      setDocumentDraft(null)
    } catch (restoreError) {
      setError(getApiErrorMessage(restoreError, 'Failed to restore routine.'))
    } finally {
      setIsSaving(false)
      setIsLifecycleBusy(false)
    }
  }

  const updateForm = (updater: (current: RoutineFormState) => RoutineFormState) => {
    routineEditorDirtyRef.current = true
    setForm((current) => current ? updater(current) : current)
  }

  const loadAssistedDraft = useCallback(async () => {
    const prose = draftAssistProse.trim()
    if (!prose || isReadOnly) return
    setIsDraftingRoutine(true)
    setError(null)
    try {
      const response = await routinesApi.draftRoutineFromProcedure(agentId, { prose })
      const nextHeader = headerFromDraft(response.draft)
      const nextSignature = JSON.stringify(response.draft)
      routineEditorDirtyRef.current = true
      setDraftHeader(nextHeader)
      setForm(routineToForm(draftAsRoutine(response.draft, editingRoutine)))
      setValidation(response.validation)
      setValidatedDraftSignature(nextSignature)
      setDocumentDraft(null)
      setDocumentSessionNonce((nonce) => nonce + 1)
      setViewMode(routineToBlockDoc(response.draft).ok ? 'document' : 'form')
      setDraftAssistDialogOpen(false)
    } catch (draftError) {
      setError(getApiErrorMessage(draftError, 'Failed to draft routine from procedure.'))
    } finally {
      setIsDraftingRoutine(false)
    }
  }, [agentId, draftAssistProse, editingRoutine, isReadOnly])

  const openDeleteDraftDialog = useCallback(() => setDeleteDraftDialogOpen(true), [])
  const actionHandlersRef = useRef({
    archiveFromDraft,
    archivePublished,
    loadAssistedDraft,
    openDeleteDraftDialog,
    publishDraft,
    restoreArchived,
    revisePublished,
  })
  useEffect(() => {
    actionHandlersRef.current = {
      archiveFromDraft,
      archivePublished,
      loadAssistedDraft,
      openDeleteDraftDialog,
      publishDraft,
      restoreArchived,
      revisePublished,
    }
  })

  const headerActions = useMemo(() => {
    // One primary action per status; secondary is the draft's "Test draft". Everything
    // else (AI drafting, archive, delete) lives in an overflow menu so the header keeps a
    // single clear call to action instead of a row of competing buttons.
    const isDraft = editingRoutine?.status === 'draft'
    const showDraftWithAi = !isReadOnly && Boolean(form)
    const showArchiveFromDraft = isDraft && Boolean(publishedSibling)
    const showArchivePublished = editingRoutine?.status === 'published'
    const showDeleteDraft = isDraft
    const showVersionHistory = versionHistory.length > 1
    const hasOverflow =
      showVersionHistory || showDraftWithAi || showArchiveFromDraft || showArchivePublished || showDeleteDraft

    return (
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {!isReadOnly && form ? <RoutineValidationStatusIcon state={validationStatus} /> : null}
        {isDraft ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setTestDrawerOpen(true)}
            disabled={isSaving}
            title="Open a live test chat where this draft can activate, run, and hand back — without publishing it"
          >
            <FlaskConical className="mr-2 h-4 w-4" />
            Test draft
          </Button>
        ) : null}
        {editingRoutine?.status === 'published' ? (
          <Button type="button" size="sm" onClick={() => void actionHandlersRef.current.revisePublished()} disabled={isSaving}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit revision
          </Button>
        ) : null}
        {editingRoutine?.status === 'archived' ? (
          <Button type="button" size="sm" onClick={() => void actionHandlersRef.current.restoreArchived()} disabled={isSaving}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Restore
          </Button>
        ) : null}
        {!isReadOnly && form ? (
          <Button type="button" size="sm" onClick={() => void actionHandlersRef.current.publishDraft()} disabled={isSaving || !canPublishDraft}>
            <Send className="mr-2 h-4 w-4" />
            Publish
          </Button>
        ) : null}
        {hasOverflow ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" aria-label="More routine actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {showVersionHistory ? (
                <DropdownMenuItem onSelect={() => setVersionHistoryOpen(true)}>
                  <History className="mr-2 h-4 w-4" />
                  Version history
                </DropdownMenuItem>
              ) : null}
              {showDraftWithAi ? (
                <DropdownMenuItem disabled={isSaving || isDraftingRoutine} onSelect={() => setDraftAssistDialogOpen(true)}>
                  <WandSparkles className="mr-2 h-4 w-4" />
                  Draft with AI
                </DropdownMenuItem>
              ) : null}
              {showArchiveFromDraft ? (
                <DropdownMenuItem disabled={isSaving} onSelect={() => void actionHandlersRef.current.archiveFromDraft()}>
                  <Archive className="mr-2 h-4 w-4" />
                  Archive
                </DropdownMenuItem>
              ) : null}
              {showArchivePublished ? (
                <DropdownMenuItem disabled={isSaving} onSelect={() => void actionHandlersRef.current.archivePublished()}>
                  <Archive className="mr-2 h-4 w-4" />
                  Archive
                </DropdownMenuItem>
              ) : null}
              {showDeleteDraft ? (
                <>
                  {showDraftWithAi || showArchiveFromDraft ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    disabled={isSaving}
                    onSelect={() => actionHandlersRef.current.openDeleteDraftDialog()}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete draft
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    )
  }, [canPublishDraft, editingRoutine, form, isDraftingRoutine, isReadOnly, isSaving, publishedSibling, validationStatus, versionHistory.length])

  const headerBackAction = useMemo(() => (
    <Button type="button" variant="ghost" className="-ml-3 h-8 px-3 text-muted-foreground" onClick={() => router.push(listHref)}>
      <ArrowLeft className="mr-2 h-4 w-4" />
      Back to routines
    </Button>
  ), [listHref, router])

  const routineHeader = useMemo(() => ({
    actions: headerActions,
    backAction: headerBackAction,
    description: editingRoutine?.name ?? (isNewRoutine ? 'New routine' : 'Loading…'),
    title: 'Routine',
  }), [editingRoutine?.name, headerActions, headerBackAction, isNewRoutine])

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
      {editingRoutine && editingRoutine.status === 'draft' ? (
        <ChatWorkbenchDrawer
          open={testDrawerOpen}
          onOpenChange={setTestDrawerOpen}
          accountId={accountId}
          agentId={agentId}
          previewRoutineIds={[editingRoutine.id]}
        />
      ) : null}
      <RoutineVersionHistoryDrawer
        open={versionHistoryOpen}
        onOpenChange={setVersionHistoryOpen}
        versions={versionHistory}
        currentId={editingRoutine?.id}
        onOpenVersion={(routineId) => {
          setVersionHistoryOpen(false)
          router.push(buildPersistedHref(routineId))
        }}
      />
      <div className="overflow-visible rounded-lg border border-border bg-card/95 shadow-sm">
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {editingRoutine ? (
              <p className="text-xs text-muted-foreground">
                {routineStatusLabel(editingRoutine.status)} v{editingRoutine.version}
                {isReadOnly ? ' (read-only)' : ''}
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
                  onChange={(event) => {
                    routineEditorDirtyRef.current = true
                    setDraftHeader((current) => ({ ...current, name: event.target.value }))
                  }}
                  disabled={isReadOnly}
                />
                {nameLocalValidationError ? <p className="text-xs text-destructive" role="status">{nameLocalValidationError}</p> : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="routinePriority">Priority</Label>
                <Input
                  id="routinePriority"
                  type="number"
                  value={draftHeader.activation.priority}
                  onChange={(event) => {
                    routineEditorDirtyRef.current = true
                    setDraftHeader((current) => ({
                      ...current,
                      activation: { ...current.activation, priority: event.target.value },
                    }))
                  }}
                  disabled={isReadOnly}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="routineReentryMode">Reentry</Label>
                <Select
                  value={draftHeader.activation.reentryMode}
                  disabled={isReadOnly}
                  onValueChange={(value) => {
                    routineEditorDirtyRef.current = true
                    setDraftHeader((current) => ({
                      ...current,
                      activation: { ...current.activation, reentryMode: value as RoutineReentryMode },
                    }))
                  }}
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
              {viewMode !== 'document' ? <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="routineTrigger">Activation trigger</Label>
                <Textarea
                  id="routineTrigger"
                  value={draftHeader.activation.triggerDescription}
                  onChange={(event) => {
                    routineEditorDirtyRef.current = true
                    setDraftHeader((current) => ({
                      ...current,
                      activation: { ...current.activation, triggerDescription: event.target.value },
                    }))
                  }}
                  rows={2}
                  disabled={isReadOnly}
                />
              </div> : null}
            </div>
            <RoutineDiagnosticList diagnostics={routineDiagnostics} />

            <Tabs value={viewMode} onValueChange={(value) => synchronizeView(value as 'document' | 'form')}>
              <TabsList aria-label="Routine editor view">
                <TabsTrigger value="document">
                  <FileText className="h-4 w-4" />
                  Document
                </TabsTrigger>
                <TabsTrigger value="form">
                  <FormInput className="h-4 w-4" />
                  Form
                </TabsTrigger>
              </TabsList>
            </Tabs>


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

            {viewMode === 'document' && activeRoutineDraft ? (
              <RoutineDocumentTab
                key={`${agentId}:${routineRouteId}:${documentSessionNonce}`}
                draft={activeRoutineDraft}
                isReadOnly={isReadOnly}
                diagnostics={validationDiagnostics}
                onDraftChange={(nextDraft) => {
                  // Completion export is edited in the panel below, not in the document, so
                  // a document emission must not revert a panel change it never saw.
                  const mergedDraft = {
                    ...mergeDocumentHeaderChange(nextDraft, documentDraft, draftHeader),
                    ...(documentDraft?.completionExport !== undefined ? { completionExport: documentDraft.completionExport } : {}),
                  }
                  routineEditorDirtyRef.current = true
                  setDocumentDraft(mergedDraft)
                  setForm(routineToForm(draftAsRoutine(mergedDraft, editingRoutine)))
                  setDraftHeader(headerFromDraft(mergedDraft))
                }}
              />
            ) : null}

            {viewMode === 'document' && activeRoutineDraft && !isReadOnly ? (
              <RoutineCompletionExportPanel
                idPrefix="document-completion-export"
                value={activeRoutineDraft.completionExport ?? { enabled: false, triggerKinds: [], destinationRef: '' }}
                onChange={(next) => {
                  routineEditorDirtyRef.current = true
                  const merged = { ...(documentDraft ?? activeRoutineDraft), completionExport: next }
                  setDocumentDraft(merged)
                  setForm(routineToForm(draftAsRoutine(merged, editingRoutine)))
                }}
                webhookDestinations={webhookDestinations}
                isLoading={isWebhookDestinationsLoading}
                error={webhookDestinationsError}
              />
            ) : null}

            </RoutineSkillCatalogProvider>
          )}
        </div>
      </div>
      <AlertDialog open={deleteDraftDialogOpen} onOpenChange={setDeleteDraftDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete draft?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the draft for {editingRoutine?.name ? `"${editingRoutine.name}"` : 'this routine'}. Published or archived versions in the lineage are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isSaving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                void deleteDraft()
              }}
            >
              Delete draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
