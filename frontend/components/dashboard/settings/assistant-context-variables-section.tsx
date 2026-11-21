'use client'

import { useEffect, useMemo, useState } from 'react'
import { Braces, Pencil, Plus, Trash2 } from 'lucide-react'

import { AttributeAdvancedFields } from '@/components/dashboard/settings/attribute-advanced-fields'
import {
  attributeHelp,
  defaultAdvancedSettings,
  sourceLabels,
  surfacingLabels,
  valueTypeLabels,
  type SourceOption,
  type SurfacingOption,
  type ValueTypeOption,
} from '@/components/dashboard/settings/attribute-copy'
import { AttributeOptionsEditor, attributeOptionsError } from '@/components/dashboard/settings/attribute-options-editor'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { SettingFieldHeader } from '@/components/dashboard/settings/settings-flow'
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
import { getApiErrorCode, getApiErrorMessage } from '@/lib/api-error'
import {
  contextVariablesApi,
  type AgentContextVariableEnablement,
  type AgentContextVariableEnablementRequest,
  type ContextVariable,
  type ContextVariableCreateRequest,
  type ContextVariableOption,
} from '@/lib/api'

type SaveState = { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }
type TrustTierOption = ContextVariableCreateRequest['trustTier']
type SensitivityOption = ContextVariableCreateRequest['sensitivity']

type VariableFormState = {
  name: string
  description: string
  valueType: ValueTypeOption
  options: ContextVariableOption[]
  trustTier: TrustTierOption
  sensitivity: SensitivityOption
  defaultSurfacing: SurfacingOption
}

const emptyForm: VariableFormState = {
  name: '',
  description: '',
  valueType: 'json',
  options: [],
  ...defaultAdvancedSettings,
}

const activeOptionCount = (options: readonly ContextVariableOption[]): string => {
  const count = options.filter((option) => !option.archived).length
  return `${count} ${count === 1 ? 'option' : 'options'}`
}

const isUiSource = (source: AgentContextVariableEnablement['source']): source is SourceOption =>
  source === 'pushed'

const variableToForm = (variable: ContextVariable): VariableFormState => ({
  name: variable.name,
  description: variable.description ?? '',
  valueType: variable.valueType,
  options: variable.options ? [...variable.options] : [],
  trustTier: variable.trustTier,
  sensitivity: variable.sensitivity,
  defaultSurfacing: variable.defaultSurfacing,
})

const formToPayload = (form: VariableFormState): ContextVariableCreateRequest => ({
  name: form.name.trim(),
  description: form.description.trim() || null,
  valueType: form.valueType,
  options: form.valueType === 'enum' ? form.options.map((option) => ({ ...option, label: option.label.trim() })) : null,
  trustTier: form.trustTier,
  sensitivity: form.sensitivity,
  defaultSurfacing: form.defaultSurfacing,
})

const enablementDefaults = (variable: ContextVariable): AgentContextVariableEnablementRequest => ({
  source: 'pushed',
  surfacing: variable.defaultSurfacing,
  enabled: true,
})

const enablementToRequest = (
  enablement: AgentContextVariableEnablement | undefined,
  variable: ContextVariable,
  patch: Partial<AgentContextVariableEnablementRequest>,
): AgentContextVariableEnablementRequest => ({
  source: patch.source ?? (enablement && isUiSource(enablement.source) ? enablement.source : 'pushed'),
  surfacing: patch.surfacing ?? enablement?.surfacing ?? variable.defaultSurfacing,
  enabled: patch.enabled ?? enablement?.enabled ?? true,
})

export function AssistantContextVariablesSection({
  agentId,
  onSaveStateChange,
  onEnablementSaved,
}: {
  agentId: string
  onSaveStateChange?: (input: SaveState) => void
  onEnablementSaved?: () => void
}) {
  const [catalog, setCatalog] = useState<ContextVariable[]>([])
  const [enablements, setEnablements] = useState<AgentContextVariableEnablement[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingVariable, setEditingVariable] = useState<ContextVariable | null>(null)
  const [deletingVariable, setDeletingVariable] = useState<ContextVariable | null>(null)
  const [form, setForm] = useState<VariableFormState>(emptyForm)
  const [nameTouched, setNameTouched] = useState(false)
  const [optionsTouched, setOptionsTouched] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const { beginSave, isCurrentSave, markError, markSaved, resetSaveState } = useSettingsSaveStatus(onSaveStateChange)

  const enablementsByVariableId = useMemo(() => {
    const lookup = new Map<string, AgentContextVariableEnablement>()
    for (const enablement of enablements) {
      lookup.set(enablement.variableId, enablement)
    }
    return lookup
  }, [enablements])

  const nameError = useMemo(() => {
    const name = form.name.trim()
    if (!name) return 'Name is required.'
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) return 'Use letters, numbers, and underscores. Start with a letter.'
    return null
  }, [form.name])
  const optionsError = useMemo(
    () => (form.valueType === 'enum' ? attributeOptionsError(form.options) : null),
    [form.valueType, form.options],
  )
  const formError = nameError ?? optionsError

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setIsLoading(true)
      setError(null)
      void Promise.all([
        contextVariablesApi.listCatalog(),
        contextVariablesApi.listAgentEnablements(agentId),
      ])
        .then(([catalogResponse, enablementResponse]) => {
          if (!active) return
          setCatalog(catalogResponse.contextVariables)
          setEnablements(enablementResponse.enablements)
        })
        .catch((loadError) => {
          if (active) setError(getApiErrorMessage(loadError, 'Failed to load attributes.'))
        })
        .finally(() => {
          if (active) setIsLoading(false)
        })
    })
    return () => {
      active = false
    }
  }, [agentId])

  const openCreateDialog = () => {
    setEditingVariable(null)
    setForm(emptyForm)
    setNameTouched(false)
    setOptionsTouched(false)
    setDialogError(null)
    setError(null)
    setDialogOpen(true)
  }

  const openEditDialog = (variable: ContextVariable) => {
    setEditingVariable(variable)
    setForm(variableToForm(variable))
    setNameTouched(false)
    setOptionsTouched(false)
    setDialogError(null)
    setError(null)
    setDialogOpen(true)
  }

  const closeDialog = () => {
    if (isSaving) return
    // The title and fields stay as they are until the dialog has animated out; opening resets them.
    setDialogOpen(false)
    setNameTouched(false)
    setOptionsTouched(false)
    setDialogError(null)
  }

  const mergeCatalogVariable = (variable: ContextVariable) => {
    setCatalog((current) => {
      const withoutVariable = current.filter((item) => item.id !== variable.id)
      return [...withoutVariable, variable].sort((first, second) => first.name.localeCompare(second.name))
    })
  }

  const mergeEnablement = (enablement: AgentContextVariableEnablement) => {
    setEnablements((current) => {
      const withoutEnablement = current.filter((item) => item.variableId !== enablement.variableId)
      return [...withoutEnablement, enablement]
    })
  }

  const handleSaveVariable = async () => {
    if (formError) return
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    setDialogError(null)
    try {
      const payload = formToPayload(form)
      const response = editingVariable
        ? await contextVariablesApi.updateCatalogVariable(editingVariable.id, payload)
        : await contextVariablesApi.createCatalogVariable(payload)
      if (!isCurrentSave(saveId)) return
      mergeCatalogVariable(response.contextVariable)
      setDialogOpen(false)
      setNameTouched(false)
      setOptionsTouched(false)
      markSaved()
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return
      // The dialog is open and covers the page header, so the refusal is shown there.
      setDialogError(getApiErrorCode(saveError) === 'context_variable_has_values'
        ? 'This attribute has values, so its type can’t change.'
        : getApiErrorMessage(saveError, 'Failed to save attribute.'))
      resetSaveState()
    } finally {
      if (isCurrentSave(saveId)) setIsSaving(false)
    }
  }

  const updateEnablement = async (
    variable: ContextVariable,
    enablement: AgentContextVariableEnablement | undefined,
    patch: Partial<AgentContextVariableEnablementRequest>,
  ) => {
    const saveId = beginSave()
    const actionKey = `enablement:${variable.id}`
    setBusyAction(actionKey)
    setError(null)
    try {
      const payload = enablementToRequest(enablement, variable, patch)
      const response = await contextVariablesApi.upsertAgentEnablement(agentId, variable.id, payload)
      if (!isCurrentSave(saveId)) return
      mergeEnablement(response.enablement)
      markSaved()
      onEnablementSaved?.()
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(saveError, 'Failed to update attribute.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) setBusyAction(null)
    }
  }

  const disableEnablement = async (variable: ContextVariable, enablement: AgentContextVariableEnablement | undefined) => {
    if (!enablement) return
    const saveId = beginSave()
    const actionKey = `enablement:${variable.id}`
    setBusyAction(actionKey)
    setError(null)
    try {
      await contextVariablesApi.deleteAgentEnablement(agentId, variable.id)
      if (!isCurrentSave(saveId)) return
      setEnablements((current) => current.filter((item) => item.variableId !== variable.id))
      markSaved()
      onEnablementSaved?.()
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(saveError, 'Failed to disable attribute.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) setBusyAction(null)
    }
  }

  const handleDeleteVariable = async () => {
    if (!deletingVariable) return
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    try {
      await contextVariablesApi.deleteCatalogVariable(deletingVariable.id)
      if (!isCurrentSave(saveId)) return
      setCatalog((current) => current.filter((item) => item.id !== deletingVariable.id))
      setEnablements((current) => current.filter((item) => item.variableId !== deletingVariable.id))
      setDeletingVariable(null)
      markSaved()
    } catch (deleteError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(deleteError, 'Failed to delete attribute.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) setIsSaving(false)
    }
  }

  return (
    <SettingsCard
      id="assistant-context-variables-card"
      icon={<Braces className="h-5 w-5 text-primary" />}
      title="Attributes"
      description="Typed facts about a conversation or visitor. Turn on the ones this agent uses."
      headerEnd={(
        <Button type="button" size="sm" onClick={openCreateDialog}>
          <Plus className="mr-2 h-4 w-4" />
          Add attribute
        </Button>
      )}
    >
      <div className="space-y-5">
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

        <p className="rounded-lg border border-border bg-muted/35 p-3 text-sm text-muted-foreground">
          Attributes hold what you know about a conversation or visitor — such as the topic, the current cart, or the
          plan — so this agent, its routines and your automations share it. Your website or API sets the values.
          Built-in page and visitor-identity context is managed by Radioso and isn&apos;t listed here. Use the{' '}
          <span className="font-medium text-foreground">?</span> next to a field to see what it does.
        </p>
        <p className="text-xs text-muted-foreground">Shared attribute definitions apply live to every agent that uses them. This agent&apos;s enablement changes are saved to its private draft and go live on Review &amp; Publish.</p>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading attributes...
          </div>
        ) : catalog.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No attributes yet.
          </p>
        ) : (
          <div className="space-y-3">
            {catalog.map((variable) => {
              const enablement = enablementsByVariableId.get(variable.id)
              const enabled = Boolean(enablement)
              const source = enablement && isUiSource(enablement.source) ? enablement.source : 'pushed'
              const busy = busyAction === `enablement:${variable.id}`
              return (
                <article key={variable.id} className="space-y-4 rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-mono text-sm font-medium text-foreground">@{variable.name}</p>
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {valueTypeLabels[variable.valueType]}
                          {variable.options ? ` · ${activeOptionCount(variable.options)}` : null}
                        </span>
                        {variable.trustTier === 'signed' ? (
                          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">Signed</span>
                        ) : null}
                        {variable.sensitivity === 'sensitive' ? (
                          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">Private</span>
                        ) : null}
                      </div>
                      {variable.description ? (
                        <p className="text-sm text-muted-foreground">{variable.description}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Switch
                        checked={enabled}
                        onCheckedChange={(checked) =>
                          checked
                            ? void updateEnablement(variable, enablement, enablementDefaults(variable))
                            : void disableEnablement(variable, enablement)
                        }
                        disabled={busy}
                        aria-label={`${enabled ? 'Disable' : 'Enable'} ${variable.name}`}
                      />
                      <Button type="button" variant="ghost" size="sm" onClick={() => openEditDialog(variable)} aria-label={`Edit ${variable.name}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setDeletingVariable(variable)} aria-label={`Delete ${variable.name}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {enabled ? (
                    <div className="grid gap-4 rounded-lg border border-border/70 bg-muted/25 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                      <div className="space-y-2">
                        <SettingFieldHeader
                          htmlFor={`context-source-${variable.id}`}
                          label="Set by"
                          tooltip={attributeHelp.setBy.tooltip}
                        />
                        <Select
                          value={source}
                          onValueChange={(value) => void updateEnablement(variable, enablement, { source: value as SourceOption })}
                          disabled={busy}
                        >
                          <SelectTrigger id={`context-source-${variable.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="pushed">{sourceLabels.pushed}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <SettingFieldHeader
                          htmlFor={`context-surfacing-${variable.id}`}
                          label="Used by"
                          tooltip={attributeHelp.usedBy.tooltip}
                        />
                        <Select
                          value={enablement?.surfacing ?? variable.defaultSurfacing}
                          onValueChange={(value) => void updateEnablement(variable, enablement, { surfacing: value as SurfacingOption })}
                          disabled={busy}
                        >
                          <SelectTrigger id={`context-surfacing-${variable.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(surfacingLabels) as SurfacingOption[]).map((surfacing) => (
                              <SelectItem key={surfacing} value={surfacing}>{surfacingLabels[surfacing]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-2 pb-2">
                        {busy ? <Spinner className="h-4 w-4" /> : null}
                      </div>
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingVariable ? 'Edit attribute' : 'Add attribute'}</DialogTitle>
            <DialogDescription>
              Shared definition — changes apply live to every agent using it. Each agent separately chooses whether to enable it in its private draft.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <SettingFieldHeader
                htmlFor="contextVariableName"
                label="Name"
                description={attributeHelp.name.description}
                tooltip={attributeHelp.name.tooltip}
              />
              <Input
                id="contextVariableName"
                value={form.name}
                onChange={(event) => {
                  setNameTouched(true)
                  setDialogError(null)
                  setForm((current) => ({ ...current, name: event.target.value }))
                }}
                onBlur={() => setNameTouched(true)}
                maxLength={120}
                placeholder="cart"
              />
            </div>
            <div className="space-y-2">
              <SettingFieldHeader
                htmlFor="contextVariableDescription"
                label="Description"
                description={attributeHelp.description.description}
                tooltip={attributeHelp.description.tooltip}
              />
              <Textarea
                id="contextVariableDescription"
                value={form.description}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                rows={3}
                placeholder="What the conversation is about."
              />
            </div>
            <div className="space-y-2">
              <SettingFieldHeader
                htmlFor="contextVariableValueType"
                label="Type"
                description={attributeHelp.valueType.description}
                tooltip={attributeHelp.valueType.tooltip}
              />
              <Select
                value={form.valueType}
                onValueChange={(value) => {
                  setOptionsTouched(true)
                  setDialogError(null)
                  setForm((current) => ({ ...current, valueType: value as ValueTypeOption }))
                }}
              >
                <SelectTrigger id="contextVariableValueType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="string">{valueTypeLabels.string}</SelectItem>
                  <SelectItem value="enum">{valueTypeLabels.enum}</SelectItem>
                  <SelectItem value="json">{valueTypeLabels.json}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.valueType === 'enum' ? (
              <AttributeOptionsEditor
                options={form.options}
                savedCount={editingVariable?.options?.length ?? 0}
                onChange={(options) => {
                  setOptionsTouched(true)
                  setDialogError(null)
                  setForm((current) => ({ ...current, options }))
                }}
              />
            ) : null}
            <AttributeAdvancedFields
              settings={form}
              onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
            />
            {nameTouched && nameError ? <p className="text-sm text-destructive">{nameError}</p> : null}
            {optionsTouched && optionsError ? <p className="text-sm text-destructive">{optionsError}</p> : null}
            {dialogError ? <p className="text-sm text-destructive" role="alert">{dialogError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSaveVariable()} disabled={Boolean(formError)} loading={isSaving}>
              {editingVariable ? 'Save attribute' : 'Add attribute'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deletingVariable)} onOpenChange={(open) => !open && !isSaving && setDeletingVariable(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete attribute?</DialogTitle>
            <DialogDescription>
              This removes the catalog declaration and disables it for agents that use it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeletingVariable(null)} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void handleDeleteVariable()} loading={isSaving}>
              Delete attribute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  )
}
