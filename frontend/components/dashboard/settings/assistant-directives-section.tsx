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
}

type OverrideTarget = BuiltInDirective

const emptyForm: DirectiveFormState = {
  name: '',
  conditionKind: 'always',
  conditionDescription: '',
  action: '',
}

const directiveToForm = (directive: Directive): DirectiveFormState => ({
  name: directive.name,
  conditionKind: directive.condition.kind,
  conditionDescription: directive.condition.kind === 'contextual' ? directive.condition.description : '',
  action: directive.action,
})

const overrideNameFor = (builtInName: string): string => `Override: ${builtInName}`

const formToPayload = (
  form: DirectiveFormState,
  options: { name?: string; excludes?: string[] } = {},
): DirectiveCreateRequest => {
  const condition: DirectiveCondition =
    form.conditionKind === 'contextual'
      ? { kind: 'contextual', description: form.conditionDescription.trim() }
      : { kind: 'always' }

  const payload: DirectiveCreateRequest = {
    name: options.name ?? form.name.trim(),
    condition,
    action: form.action.trim(),
  }
  if (options.excludes && options.excludes.length > 0) {
    payload.excludes = options.excludes
  }
  return payload
}

const describeCondition = (condition: DirectiveCondition): string =>
  condition.kind === 'always' ? 'Always applies' : `When: ${condition.description}`

function CoherencePanel({ coherence }: { coherence: DirectiveCoherence }) {
  if (coherence.coherent) {
    return (
      <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground" role="status">
        No directive conflicts were found.
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/50 p-4" role="status">
      <div>
        <p className="text-sm font-medium text-foreground">Potential directive conflicts</p>
        <p className="text-sm text-muted-foreground">{coherence.rationale}</p>
      </div>
      {coherence.conflicts.length > 0 ? (
        <ul className="space-y-2">
          {coherence.conflicts.map((conflict) => (
            <li key={`${conflict.directiveName}-${conflict.reason}`} className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{conflict.directiveName}:</span> {conflict.reason}
            </li>
          ))}
        </ul>
      ) : null}
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
  const [editingDirective, setEditingDirective] = useState<Directive | null>(null)
  const [overrideTarget, setOverrideTarget] = useState<OverrideTarget | null>(null)
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

  const formError = useMemo(() => {
    if (!overrideTarget && !form.name.trim()) return 'Name is required.'
    if (!form.action.trim()) return 'Action is required.'
    if (form.conditionKind === 'contextual' && !form.conditionDescription.trim()) {
      return 'Contextual directives need a condition description.'
    }
    return null
  }, [form, overrideTarget])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setIsLoading(true)
      setDirectives([])
      setBuiltIns([])
      setCoherence(null)
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
    setOverrideTarget(null)
    setForm(emptyForm)
    setError(null)
    setDialogOpen(true)
  }

  const openEditDialog = (directive: Directive) => {
    setEditingDirective(directive)
    setOverrideTarget(null)
    setForm(directiveToForm(directive))
    setError(null)
    setDialogOpen(true)
  }

  const openOverrideDialog = (directive: BuiltInDirective) => {
    setEditingDirective(null)
    setOverrideTarget(directive)
    setForm({
      ...emptyForm,
      name: overrideNameFor(directive.name),
    })
    setError(null)
    setDialogOpen(true)
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
    setOverrideTarget(null)
    setForm(emptyForm)
  }

  const handleSubmit = async () => {
    if (formError) return
    const payload = formToPayload(form, {
      name: overrideTarget ? overrideNameFor(overrideTarget.name) : undefined,
      excludes: overrideTarget ? [overrideTarget.name] : editingDirective?.excludes,
    })
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    try {
      const response = editingDirective
        ? await directivesApi.updateDirective(agentId, editingDirective.id, payload satisfies DirectiveUpdateRequest)
        : await directivesApi.createDirective(agentId, payload)
      if (!isCurrentSave(saveId)) return
      setDirectives((current) => {
        const withoutSaved = current.filter((directive) => directive.id !== response.directive.id)
        return [...withoutSaved, response.directive].sort((first, second) => first.name.localeCompare(second.name))
      })
      setCoherence(response.coherence)
      setDialogOpen(false)
      setEditingDirective(null)
      setOverrideTarget(null)
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
      description="Standing behavior rules that steer how this agent answers."
      headerEnd={(
        <Button type="button" size="sm" onClick={openCreateDialog}>
          <Plus className="mr-2 h-4 w-4" />
          New directive
        </Button>
      )}
    >
      <div className="space-y-6">
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {coherence ? <CoherencePanel coherence={coherence} /> : null}

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
                  replaces={(directive.excludes ?? []).filter((name) => builtIns.some((builtIn) => builtIn.name === name))}
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
              {overrideTarget ? `Replace the default "${overrideTarget.name}"` : editingDirective ? 'Edit directive' : 'Create directive'}
            </DialogTitle>
            <DialogDescription>
              {overrideTarget
                ? 'Replace this default for the current agent. Coherence checks are advisory and do not block saving.'
                : 'Add a standing rule for this agent. Coherence checks are advisory and do not block saving.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {overrideTarget ? null : (
              <div className="space-y-2">
                <Label htmlFor="directiveName">Name</Label>
                <Input
                  id="directiveName"
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  maxLength={120}
                />
              </div>
            )}
            <div className="space-y-2">
              <div className="space-y-2">
                <Label htmlFor="directiveConditionKind">{overrideTarget ? 'Scope' : 'Condition'}</Label>
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
                    <SelectItem value="contextual">{overrideTarget ? 'Only when condition matches' : 'Contextual'}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {form.conditionKind === 'contextual' ? (
              <div className="space-y-2">
                <Label htmlFor="directiveConditionDescription">{overrideTarget ? 'Only when' : 'Condition description'}</Label>
                <Textarea
                  id="directiveConditionDescription"
                  value={form.conditionDescription}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, conditionDescription: event.target.value }))
                  }
                  className="min-h-20"
                />
                <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground" role="note">
                  <span className="font-medium text-foreground">Not active yet:</span> contextual conditions aren&apos;t evaluated yet, so this {overrideTarget ? 'override' : 'directive'} is saved but won&apos;t take effect until contextual matching is enabled.
                </div>
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
