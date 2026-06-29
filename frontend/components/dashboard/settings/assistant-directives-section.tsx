'use client'

import { useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, ScrollText, Trash2 } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Textarea } from '@/components/ui/textarea'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  directivesApi,
  type BuiltInDirective,
  type Directive,
  type DirectiveCoherence,
  type DirectiveCondition,
  type DirectiveCreateRequest,
  type DirectiveUpdateRequest,
} from '@/lib/api'

type DirectiveFormState = {
  name: string
  conditionKind: DirectiveCondition['kind']
  conditionDescription: string
  action: string
  priority: string
  replaces: string[]
}

export const DIRECTIVE_PRIORITY = { min: 0, max: 100 } as const

const emptyForm: DirectiveFormState = {
  name: '',
  conditionKind: 'always',
  conditionDescription: '',
  action: '',
  priority: '',
  replaces: [],
}

const directiveToForm = (directive: Directive): DirectiveFormState => ({
  name: directive.name,
  conditionKind: directive.condition.kind,
  conditionDescription: directive.condition.kind === 'contextual' ? directive.condition.description : '',
  action: directive.action,
  priority: directive.priority == null ? '' : String(directive.priority),
  replaces: directive.excludes ?? [],
})

const overrideNameFor = (builtInName: string): string => `Override: ${builtInName}`

const parsePriority = (raw: string): number | null => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isInteger(value) ? value : null
}

const formToPayload = (form: DirectiveFormState): DirectiveCreateRequest => {
  const condition: DirectiveCondition =
    form.conditionKind === 'contextual'
      ? { kind: 'contextual', description: form.conditionDescription.trim() }
      : { kind: 'always' }

  const replaces = dedupeNames(form.replaces.map((name) => name.trim()).filter(Boolean))
  const payload: DirectiveCreateRequest = {
    name: form.name.trim(),
    condition,
    action: form.action.trim(),
    priority: parsePriority(form.priority),
  }
  if (replaces.length > 0) {
    payload.excludes = replaces
  }
  return payload
}

const directiveToPayload = (
  directive: Directive,
  options: { excludes?: string[] } = {},
): DirectiveUpdateRequest => ({
  name: directive.name,
  condition: directive.condition,
  action: directive.action,
  priority: directive.priority,
  requiredCapabilities: directive.requiredCapabilities,
  dependsOn: directive.dependsOn,
  excludes: options.excludes ?? directive.excludes,
  description: directive.description,
  metadata: directive.metadata,
})

const dedupeNames = (names: string[]): string[] => Array.from(new Set(names))

const describeCondition = (condition: DirectiveCondition): string =>
  condition.kind === 'always' ? 'Always applies' : `When: ${condition.description}`

function CoherenceResolver({
  coherence,
  directives,
  subjectId,
  onSupersede,
  onMakeConditional,
  isSaving,
}: {
  coherence: DirectiveCoherence
  directives: Directive[]
  subjectId: string | null
  onSupersede: (winner: Directive, loser: Directive) => void
  onMakeConditional: (directive: Directive) => void
  isSaving: boolean
}) {
  if (coherence.coherent) {
    return (
      <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground" role="status">
        No directive conflicts were found.
      </div>
    )
  }

  const subject = subjectId ? directives.find((directive) => directive.id === subjectId) : undefined

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/50 p-4" role="status">
      <div>
        <p className="text-sm font-medium text-foreground">Potential directive conflicts</p>
        <p className="text-sm text-muted-foreground">{coherence.rationale}</p>
      </div>
      {coherence.conflicts.length > 0 ? (
        <div className="space-y-3">
          {coherence.conflicts.map((conflict) => {
            const existing = directives.find((directive) =>
              conflict.directiveId ? directive.id === conflict.directiveId : directive.name === conflict.directiveName
            )
            const canResolve = subject && existing && subject.id !== existing.id
            return (
              <div key={`${conflict.directiveName}-${conflict.reason}`} className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{conflict.directiveName}:</span> {conflict.reason}
                </p>
                {subject && existing && canResolve ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isSaving}
                      onClick={() => onSupersede(subject, existing)}
                      aria-label={`${subject.name} supersedes ${existing.name}`}
                    >
                      {subject.name} supersedes {existing.name}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isSaving}
                      onClick={() => onSupersede(existing, subject)}
                      aria-label={`${existing.name} supersedes ${subject.name}`}
                    >
                      {existing.name} supersedes {subject.name}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isSaving}
                      onClick={() => onMakeConditional(subject)}
                      aria-label={`Make ${subject.name} apply only conditionally`}
                    >
                      Make {subject.name} apply only conditionally
                    </Button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function ReplaceToggle({
  candidate,
  checked,
  onToggle,
}: {
  candidate: { name: string; description: string | null }
  checked: boolean
  onToggle: (checked: boolean) => void
}) {
  const switchId = `directive-replace-${candidate.name}`
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={switchId} className="text-sm font-medium text-foreground">
          {candidate.name}
        </Label>
        {candidate.description ? (
          <p className="text-xs text-muted-foreground">{candidate.description}</p>
        ) : null}
      </div>
      <Switch
        id={switchId}
        checked={checked}
        onCheckedChange={onToggle}
        aria-label={`Replace ${candidate.name}`}
      />
    </div>
  )
}

function DirectiveRow({
  id,
  directive,
  readOnly = false,
  replacedBy,
  replaces,
  onEdit,
  onDelete,
  onOverride,
  onFocusReplacement,
}: {
  id?: string
  directive: Directive | BuiltInDirective
  readOnly?: boolean
  replacedBy?: Directive
  replaces?: string[]
  onEdit?: () => void
  onDelete?: () => void
  onOverride?: () => void
  onFocusReplacement?: () => void
}) {
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      className={`space-y-3 rounded-lg border border-border p-4 ${replacedBy ? 'bg-muted/40 text-muted-foreground' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className={`text-sm font-medium text-foreground ${replacedBy ? 'line-through decoration-muted-foreground/70' : ''}`}>
              {directive.name}
            </p>
            {readOnly ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                Read-only
              </span>
            ) : null}
            {directive.priority != null ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                Priority {directive.priority}
              </span>
            ) : null}
            {replaces?.map((name) => (
              <span key={name} className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                Replaces: {name}
              </span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {describeCondition(directive.condition)}
          </p>
          {replacedBy ? (
            <p className="text-xs text-muted-foreground">
              Replaced by{' '}
              <button
                type="button"
                className="font-medium text-foreground underline-offset-4 hover:underline"
                onClick={onFocusReplacement}
              >
                {replacedBy.name}
              </button>
            </p>
          ) : null}
          {'description' in directive && directive.description ? (
            <p className="text-xs text-muted-foreground">{directive.description}</p>
          ) : null}
        </div>
        {readOnly && !replacedBy ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOverride}
            aria-label={`Replace ${directive.name} for this agent`}
          >
            Override
          </Button>
        ) : !readOnly ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${directive.name}`}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onDelete} aria-label={`Delete ${directive.name}`}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>
      <p className={`text-sm ${replacedBy ? 'text-muted-foreground' : 'text-foreground'}`}>{directive.action}</p>
    </div>
  )
}

export function AssistantDirectivesSection({
  agentId,
  onSaveStateChange,
}: {
  agentId: string
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  const [directives, setDirectives] = useState<Directive[]>([])
  const [builtIns, setBuiltIns] = useState<BuiltInDirective[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [coherence, setCoherence] = useState<DirectiveCoherence | null>(null)
  const [coherenceSubjectId, setCoherenceSubjectId] = useState<string | null>(null)
  const [editingDirective, setEditingDirective] = useState<Directive | null>(null)
  const [deletingDirective, setDeletingDirective] = useState<Directive | null>(null)
  const [form, setForm] = useState<DirectiveFormState>(emptyForm)
  const [dialogOpen, setDialogOpen] = useState(false)
  const { beginSave, isCurrentSave, markError, markSaved } = useSettingsSaveStatus(onSaveStateChange)
  const supersededBuiltIns = useMemo(() => {
    const replacements = new Map<string, Directive>()
    for (const directive of directives) {
      for (const builtInName of directive.excludes ?? []) {
        if (!replacements.has(builtInName)) {
          replacements.set(builtInName, directive)
        }
      }
    }
    return replacements
  }, [directives])

  const replaceCandidates = useMemo(() => {
    const authored = directives
      .filter((directive) => directive.id !== editingDirective?.id)
      .map((directive) => ({ name: directive.name, description: directive.description ?? null }))
    const builtInTargets = builtIns.map((directive) => ({ name: directive.name, description: directive.description ?? null }))
    return { builtIns: builtInTargets, authored }
  }, [builtIns, directives, editingDirective])

  const formError = useMemo(() => {
    if (!form.name.trim()) return 'Name is required.'
    if (!form.action.trim()) return 'Action is required.'
    if (form.conditionKind === 'contextual' && !form.conditionDescription.trim()) {
      return 'Contextual directives need a condition description.'
    }
    const trimmedPriority = form.priority.trim()
    if (trimmedPriority !== '') {
      const value = Number(trimmedPriority)
      if (!Number.isInteger(value) || value < DIRECTIVE_PRIORITY.min || value > DIRECTIVE_PRIORITY.max) {
        return `Priority must be a whole number between ${DIRECTIVE_PRIORITY.min} and ${DIRECTIVE_PRIORITY.max}.`
      }
    }
    return null
  }, [form])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setIsLoading(true)
      setDirectives([])
      setBuiltIns([])
      setCoherence(null)
      setCoherenceSubjectId(null)
      setError(null)
      void directivesApi.listDirectives(agentId)
        .then((response) => {
          if (!active) return
          setDirectives(response.directives)
          setBuiltIns(response.builtIns)
          setError(null)
        })
        .catch((loadError) => {
          if (!active) return
          setError(getApiErrorMessage(loadError, 'Failed to load directives.'))
        })
        .finally(() => {
          if (!active) return
          setIsLoading(false)
        })
    })
    return () => {
      active = false
    }
  }, [agentId])

  const openCreateDialog = () => {
    setEditingDirective(null)
    setForm(emptyForm)
    setError(null)
    setDialogOpen(true)
  }

  const openEditDialog = (directive: Directive) => {
    setEditingDirective(directive)
    setForm(directiveToForm(directive))
    setError(null)
    setDialogOpen(true)
  }

  const openConditionalEditDialog = (directive: Directive) => {
    setEditingDirective(directive)
    setForm({
      ...directiveToForm(directive),
      conditionKind: 'contextual',
    })
    setError(null)
    setDialogOpen(true)
  }

  // The per-built-in "Override" button is a shortcut into the normal create
  // dialog with the built-in pre-selected in Replaces, so it reads as
  // "cancel this built-in and run mine instead" with everything else editable.
  const openOverrideDialog = (directive: BuiltInDirective) => {
    setEditingDirective(null)
    setForm({
      ...emptyForm,
      name: overrideNameFor(directive.name),
      replaces: [directive.name],
    })
    setError(null)
    setDialogOpen(true)
  }

  const toggleReplace = (name: string, checked: boolean) => {
    setForm((current) => ({
      ...current,
      replaces: checked
        ? dedupeNames([...current.replaces, name])
        : current.replaces.filter((replaced) => replaced !== name),
    }))
  }

  const focusDirective = (directiveId: string) => {
    const element = document.getElementById(`directive-${directiveId}`)
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element?.focus({ preventScroll: true })
  }

  const closeDialog = () => {
    if (isSaving) return
    setDialogOpen(false)
    setEditingDirective(null)
    setForm(emptyForm)
  }

  const mergeSavedDirective = (savedDirective: Directive) => {
    setDirectives((current) => {
      const withoutSaved = current.filter((directive) => directive.id !== savedDirective.id)
      return [...withoutSaved, savedDirective].sort((first, second) => first.name.localeCompare(second.name))
    })
  }

  const handleSupersede = async (winner: Directive, loser: Directive) => {
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    try {
      const response = await directivesApi.updateDirective(
        agentId,
        winner.id,
        directiveToPayload(winner, {
          excludes: dedupeNames([...(winner.excludes ?? []), loser.name]),
        }),
      )
      if (!isCurrentSave(saveId)) return
      mergeSavedDirective(response.directive)
      setCoherence(response.coherence)
      setCoherenceSubjectId(response.directive.id)
      markSaved()
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(saveError, 'Failed to resolve directive conflict.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) {
        setIsSaving(false)
      }
    }
  }

  const handleSubmit = async () => {
    if (formError) return
    const payload = formToPayload(form)
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    try {
      const response = editingDirective
        ? await directivesApi.updateDirective(agentId, editingDirective.id, payload satisfies DirectiveUpdateRequest)
        : await directivesApi.createDirective(agentId, payload)
      if (!isCurrentSave(saveId)) return
      mergeSavedDirective(response.directive)
      setCoherence(response.coherence)
      setCoherenceSubjectId(response.directive.id)
      setDialogOpen(false)
      setEditingDirective(null)
      setForm(emptyForm)
      markSaved()
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(saveError, 'Failed to save directive.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) {
        setIsSaving(false)
      }
    }
  }

  const handleDelete = async () => {
    if (!deletingDirective) return
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    try {
      await directivesApi.deleteDirective(agentId, deletingDirective.id)
      if (!isCurrentSave(saveId)) return
      setDirectives((current) => current.filter((directive) => directive.id !== deletingDirective.id))
      setDeletingDirective(null)
      setCoherence(null)
      setCoherenceSubjectId(null)
      markSaved()
    } catch (deleteError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(deleteError, 'Failed to delete directive.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) {
        setIsSaving(false)
      }
    }
  }

  return (
    <SettingsCard
      id="assistant-directives-card"
      icon={<ScrollText className="h-5 w-5 text-primary" />}
      title="Directives"
      description={'Conditional rules that fire in specific situations — for "when X, do Y" behavior. For the agent\'s always-on persona, use Behavior; for multi-step procedures, use Routines.'}
      headerEnd={(
        <Button type="button" size="sm" onClick={openCreateDialog}>
          <Plus className="mr-2 h-4 w-4" />
          New directive
        </Button>
      )}
    >
      <div className="space-y-6">
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {coherence ? (
          <CoherenceResolver
            coherence={coherence}
            directives={directives}
            subjectId={coherenceSubjectId}
            onSupersede={(winner, loser) => void handleSupersede(winner, loser)}
            onMakeConditional={openConditionalEditDialog}
            isSaving={isSaving}
          />
        ) : null}

        <div className="space-y-3">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-foreground">Authored directives</h4>
            <p className="text-xs text-muted-foreground">Rules created for this agent. They apply to all routes.</p>
          </div>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" />
              Loading directives...
            </div>
          ) : directives.length > 0 ? (
            <div className="space-y-3">
              {directives.map((directive) => (
                <DirectiveRow
                  key={directive.id}
                  id={`directive-${directive.id}`}
                  directive={directive}
                  replaces={directive.excludes ?? []}
                  onEdit={() => openEditDialog(directive)}
                  onDelete={() => setDeletingDirective(directive)}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              No authored directives yet.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-foreground">Built-in directives</h4>
            <p className="text-xs text-muted-foreground">Default Radioso behavior rules. They cannot be edited here.</p>
          </div>
          <div className="space-y-3">
            {builtIns.map((directive) => {
              const replacedBy = supersededBuiltIns.get(directive.name)
              return (
                <DirectiveRow
                  key={directive.name}
                  directive={directive}
                  readOnly
                  replacedBy={replacedBy}
                  onOverride={() => openOverrideDialog(directive)}
                  onFocusReplacement={replacedBy ? () => focusDirective(replacedBy.id) : undefined}
                />
              )
            })}
          </div>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingDirective ? 'Edit directive' : 'Create directive'}
            </DialogTitle>
            <DialogDescription>
              Add a standing rule for this agent. Coherence checks are advisory and do not block saving.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="directiveName">Name</Label>
              <Input
                id="directiveName"
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <div className="space-y-2">
                <Label htmlFor="directiveConditionKind">Condition</Label>
                <Select
                  value={form.conditionKind}
                  onValueChange={(value) =>
                    setForm((current) => ({ ...current, conditionKind: value as DirectiveCondition['kind'] }))
                  }
                >
                  <SelectTrigger id="directiveConditionKind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="always">Always</SelectItem>
                    <SelectItem value="contextual">Contextual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {form.conditionKind === 'contextual' ? (
              <div className="space-y-2">
                <Label htmlFor="directiveConditionDescription">Condition description</Label>
                <Textarea
                  id="directiveConditionDescription"
                  value={form.conditionDescription}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, conditionDescription: event.target.value }))
                  }
                  className="min-h-20"
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="directiveAction">Action</Label>
              <Textarea
                id="directiveAction"
                value={form.action}
                onChange={(event) => setForm((current) => ({ ...current, action: event.target.value }))}
                className="min-h-28"
              />
            </div>
            {replaceCandidates.builtIns.length > 0 || replaceCandidates.authored.length > 0 ? (
              <div className="space-y-2">
                <Label>Replaces</Label>
                <p className="text-xs text-muted-foreground">
                  When this directive applies, the ones you select are cancelled and this one runs in their
                  place. Outside its condition, they still apply as normal.
                </p>
                <div className="space-y-3 rounded-lg border border-border p-3">
                  {replaceCandidates.builtIns.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Built-in behaviors</p>
                      {replaceCandidates.builtIns.map((candidate) => (
                        <ReplaceToggle
                          key={candidate.name}
                          candidate={candidate}
                          checked={form.replaces.includes(candidate.name)}
                          onToggle={(checked) => toggleReplace(candidate.name, checked)}
                        />
                      ))}
                    </div>
                  ) : null}
                  {replaceCandidates.authored.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Your other directives</p>
                      {replaceCandidates.authored.map((candidate) => (
                        <ReplaceToggle
                          key={candidate.name}
                          candidate={candidate}
                          checked={form.replaces.includes(candidate.name)}
                          onToggle={(checked) => toggleReplace(candidate.name, checked)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="directivePriority">Priority (optional)</Label>
              <Input
                id="directivePriority"
                type="number"
                inputMode="numeric"
                min={DIRECTIVE_PRIORITY.min}
                max={DIRECTIVE_PRIORITY.max}
                value={form.priority}
                placeholder="Default"
                onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value }))}
                className="w-32"
              />
              <p className="text-xs text-muted-foreground">
                When two directives apply at once and pull in different directions, the agent follows the
                higher-priority one. Each built-in shows its priority on its row below, so you can rank above
                it. Leave blank to use the default.
              </p>
            </div>
            {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSubmit()} disabled={isSaving || Boolean(formError)}>
              {isSaving ? <Spinner className="mr-2" /> : null}
              Save directive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deletingDirective)} onOpenChange={(open) => !open && setDeletingDirective(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete directive</DialogTitle>
            <DialogDescription>
              This removes the authored directive from this agent.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Delete <span className="font-medium text-foreground">{deletingDirective?.name}</span>?
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeletingDirective(null)} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void handleDelete()} disabled={isSaving}>
              {isSaving ? <Spinner className="mr-2" /> : null}
              Delete directive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  )
}
