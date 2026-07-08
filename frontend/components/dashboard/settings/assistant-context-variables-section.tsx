'use client'

import { useEffect, useMemo, useState } from 'react'
import { Braces, Pencil, Plus, Trash2 } from 'lucide-react'

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
import { getApiErrorMessage } from '@/lib/api-error'
import {
  contextVariablesApi,
  type AgentContextVariableEnablement,
  type AgentContextVariableEnablementRequest,
  type ContextVariable,
  type ContextVariableCreateRequest,
} from '@/lib/api'
import { cn } from '@/lib/utils'

type SaveState = { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }
type SourceOption = Extract<AgentContextVariableEnablementRequest['source'], 'pushed'>
type SurfacingOption = AgentContextVariableEnablementRequest['surfacing']
type ValueTypeOption = ContextVariableCreateRequest['valueType']
type TrustTierOption = ContextVariableCreateRequest['trustTier']
type SensitivityOption = ContextVariableCreateRequest['sensitivity']

type VariableFormState = {
  name: string
  description: string
  valueType: ValueTypeOption
  trustTier: TrustTierOption
  sensitivity: SensitivityOption
  defaultSurfacing: SurfacingOption
}

const emptyForm: VariableFormState = {
  name: '',
  description: '',
  valueType: 'json',
  trustTier: 'unverified',
  sensitivity: 'normal',
  defaultSurfacing: 'on_reference',
}

const sourceLabels: Record<SourceOption, string> = {
  pushed: 'Pushed API',
}

const surfacingLabels: Record<SurfacingOption, string> = {
  always: 'Always',
  on_reference: 'On reference',
  operator_only: 'Operator only',
}

const valueTypeLabels: Record<ValueTypeOption, string> = {
  string: 'String',
  json: 'JSON',
}

const trustTierLabels: Record<TrustTierOption, string> = {
  unverified: 'Unverified',
  signed: 'Signed',
}

const sensitivityLabels: Record<SensitivityOption, string> = {
  normal: 'Normal',
  sensitive: 'Sensitive',
}

const fieldHelp = {
  name: {
    description: 'The key the agent and routines use to reference this value.',
    tooltip:
      'The stable identifier your directives, routines, and the host API use to read this value — for example `@cart`. Use letters, numbers, and underscores, and start with a letter. Visitors never see it.',
  },
  description: {
    description: 'What this value holds. Helps the agent and operators recognise it.',
    tooltip:
      'A short, human description of the value. It helps operators recognise the variable in the dashboard and gives the agent a hint about what the data represents. It does not change behaviour on its own.',
  },
  valueType: {
    description: 'String for plain text, JSON for structured data.',
    tooltip:
      '**String** — a single plain-text value, such as a plan name or an order status.\n\n**JSON** — a structured object or array, such as a full cart with line items. Choose JSON when the host sends more than one field.',
  },
  trustTier: {
    description: "How much the agent trusts the value's origin.",
    tooltip:
      '**Unverified** — the value is accepted as sent by the page or host. Fine for low-stakes context like the current page or product.\n\n**Signed** — the value is only accepted when it carries a valid signature from your backend. Use this for identity- or account-bound data (like the logged-in customer) so a visitor cannot spoof it from the browser.',
  },
  sensitivity: {
    description: 'Sensitive values get extra handling and stay out of logs.',
    tooltip:
      '**Normal** — standard handling.\n\n**Sensitive** — the value is treated as confidential: it is kept out of logs and diagnostics and handled more conservatively. Use it for anything private, like order details or personal information.',
  },
  defaultSurfacing: {
    description: 'When the value is placed into the conversation by default.',
    tooltip:
      'Controls when the value reaches a turn. Each agent can override this per variable.\n\n**Always** — included in every turn.\n\n**On reference** — included only when the turn seems to need it. A good default to keep prompts lean.\n\n**Operator only** — never sent to the model; visible only to human operators in the Activity view.',
  },
  source: {
    tooltip:
      '**Pushed API** — your backend writes the value through the Radioso REST API, and Radioso stores it per session and customer. This is the delivery method available in the dashboard today.',
  },
  surfacing: {
    tooltip:
      'When this agent places the value into a turn.\n\n**Always** — every turn. **On reference** — only when relevant. **Operator only** — hidden from the model, visible to human operators.',
  },
} as const

const isUiSource = (source: AgentContextVariableEnablement['source']): source is SourceOption =>
  source === 'pushed'

const variableToForm = (variable: ContextVariable): VariableFormState => ({
  name: variable.name,
  description: variable.description ?? '',
  valueType: variable.valueType,
  trustTier: variable.trustTier,
  sensitivity: variable.sensitivity,
  defaultSurfacing: variable.defaultSurfacing,
})

const formToPayload = (form: VariableFormState): ContextVariableCreateRequest => ({
  name: form.name.trim(),
  description: form.description.trim() || null,
  valueType: form.valueType,
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

const labelClassName = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground'

export function AssistantContextVariablesSection({
  agentId,
  onSaveStateChange,
}: {
  agentId: string
  onSaveStateChange?: (input: SaveState) => void
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
  const { beginSave, isCurrentSave, markError, markSaved } = useSettingsSaveStatus(onSaveStateChange)

  const enablementsByVariableId = useMemo(() => {
    const lookup = new Map<string, AgentContextVariableEnablement>()
    for (const enablement of enablements) {
      lookup.set(enablement.variableId, enablement)
    }
    return lookup
  }, [enablements])

  const formError = useMemo(() => {
    const name = form.name.trim()
    if (!name) return 'Name is required.'
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) return 'Use letters, numbers, and underscores. Start with a letter.'
    return null
  }, [form.name])

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
          if (active) setError(getApiErrorMessage(loadError, 'Failed to load context variables.'))
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
    setError(null)
    setDialogOpen(true)
  }

  const openEditDialog = (variable: ContextVariable) => {
    setEditingVariable(variable)
    setForm(variableToForm(variable))
    setNameTouched(false)
    setError(null)
    setDialogOpen(true)
  }

  const closeDialog = () => {
    if (isSaving) return
    setDialogOpen(false)
    setEditingVariable(null)
    setForm(emptyForm)
    setNameTouched(false)
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
    try {
      const payload = formToPayload(form)
      const response = editingVariable
        ? await contextVariablesApi.updateCatalogVariable(editingVariable.id, payload)
        : await contextVariablesApi.createCatalogVariable(payload)
      if (!isCurrentSave(saveId)) return
      mergeCatalogVariable(response.contextVariable)
      setDialogOpen(false)
      setEditingVariable(null)
      setForm(emptyForm)
      setNameTouched(false)
      markSaved()
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(saveError, 'Failed to save context variable.')
      setError(message)
      markError(message)
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
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(saveError, 'Failed to update context variable.')
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
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(saveError, 'Failed to disable context variable.')
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
      const message = getApiErrorMessage(deleteError, 'Failed to delete context variable.')
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
      title="Context"
      description="Enable host-defined context variables for this agent and choose how each value reaches a turn."
      headerEnd={(
        <Button type="button" size="sm" onClick={openCreateDialog}>
          <Plus className="mr-2 h-4 w-4" />
          Add variable
        </Button>
      )}
    >
      <div className="space-y-5">
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

        <p className="rounded-lg border border-border bg-muted/35 p-3 text-sm text-muted-foreground">
          Context variables let your site feed live visitor data — such as the current cart, order, or plan — into
          this agent so it can ground answers in it. Built-in page and visitor-identity context is managed by Radioso
          and isn&apos;t listed here; this section is for your own host-defined variables. Use the{' '}
          <span className="font-medium text-foreground">?</span> on any field for a plain-language explanation.
        </p>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading context variables...
          </div>
        ) : catalog.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No host-defined context variables yet.
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
                        </span>
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {trustTierLabels[variable.trustTier]}
                        </span>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-xs',
                            variable.sensitivity === 'sensitive'
                              ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                              : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {sensitivityLabels[variable.sensitivity]}
                        </span>
                      </div>
                      {variable.description ? (
                        <p className="text-sm text-muted-foreground">{variable.description}</p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        Default surfacing: {surfacingLabels[variable.defaultSurfacing]}
                      </p>
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
                          label="Source"
                          tooltip={fieldHelp.source.tooltip}
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
                          label="Surfacing"
                          tooltip={fieldHelp.surfacing.tooltip}
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
                            <SelectItem value="always">{surfacingLabels.always}</SelectItem>
                            <SelectItem value="on_reference">{surfacingLabels.on_reference}</SelectItem>
                            <SelectItem value="operator_only">{surfacingLabels.operator_only}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-2 pb-2">
                        {busy ? <Spinner className="h-4 w-4" /> : null}
                        <span className={labelClassName}>Enabled</span>
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
            <DialogTitle>{editingVariable ? 'Edit context variable' : 'Add context variable'}</DialogTitle>
            <DialogDescription>
              Declare the variable once for the workspace catalog. Each agent chooses whether to enable it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <SettingFieldHeader
                htmlFor="contextVariableName"
                label="Name"
                description={fieldHelp.name.description}
                tooltip={fieldHelp.name.tooltip}
              />
              <Input
                id="contextVariableName"
                value={form.name}
                onChange={(event) => {
                  setNameTouched(true)
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
                description={fieldHelp.description.description}
                tooltip={fieldHelp.description.tooltip}
              />
              <Textarea
                id="contextVariableDescription"
                value={form.description}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                rows={3}
                placeholder="Current visitor cart from the host backend."
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <SettingFieldHeader
                  htmlFor="contextVariableValueType"
                  label="Value type"
                  description={fieldHelp.valueType.description}
                  tooltip={fieldHelp.valueType.tooltip}
                />
                <Select
                  value={form.valueType}
                  onValueChange={(value) => setForm((current) => ({ ...current, valueType: value as ValueTypeOption }))}
                >
                  <SelectTrigger id="contextVariableValueType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="string">{valueTypeLabels.string}</SelectItem>
                    <SelectItem value="json">{valueTypeLabels.json}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <SettingFieldHeader
                  htmlFor="contextVariableTrustTier"
                  label="Trust tier"
                  description={fieldHelp.trustTier.description}
                  tooltip={fieldHelp.trustTier.tooltip}
                />
                <Select
                  value={form.trustTier}
                  onValueChange={(value) => setForm((current) => ({ ...current, trustTier: value as TrustTierOption }))}
                >
                  <SelectTrigger id="contextVariableTrustTier">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unverified">{trustTierLabels.unverified}</SelectItem>
                    <SelectItem value="signed">{trustTierLabels.signed}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <SettingFieldHeader
                  htmlFor="contextVariableSensitivity"
                  label="Sensitivity"
                  description={fieldHelp.sensitivity.description}
                  tooltip={fieldHelp.sensitivity.tooltip}
                />
                <Select
                  value={form.sensitivity}
                  onValueChange={(value) => setForm((current) => ({ ...current, sensitivity: value as SensitivityOption }))}
                >
                  <SelectTrigger id="contextVariableSensitivity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">{sensitivityLabels.normal}</SelectItem>
                    <SelectItem value="sensitive">{sensitivityLabels.sensitive}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <SettingFieldHeader
                  htmlFor="contextVariableDefaultSurfacing"
                  label="Default surfacing"
                  description={fieldHelp.defaultSurfacing.description}
                  tooltip={fieldHelp.defaultSurfacing.tooltip}
                />
                <Select
                  value={form.defaultSurfacing}
                  onValueChange={(value) => setForm((current) => ({ ...current, defaultSurfacing: value as SurfacingOption }))}
                >
                  <SelectTrigger id="contextVariableDefaultSurfacing">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="always">{surfacingLabels.always}</SelectItem>
                    <SelectItem value="on_reference">{surfacingLabels.on_reference}</SelectItem>
                    <SelectItem value="operator_only">{surfacingLabels.operator_only}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {nameTouched && formError ? <p className="text-sm text-destructive">{formError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSaveVariable()} disabled={Boolean(formError) || isSaving}>
              {isSaving ? <Spinner className="mr-2 h-4 w-4" /> : null}
              {editingVariable ? 'Save variable' : 'Add variable'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deletingVariable)} onOpenChange={(open) => !open && !isSaving && setDeletingVariable(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete context variable?</DialogTitle>
            <DialogDescription>
              This removes the catalog declaration and disables it for agents that use it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeletingVariable(null)} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void handleDeleteVariable()} disabled={isSaving}>
              {isSaving ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Delete variable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  )
}
