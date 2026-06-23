'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, Plus, Wrench } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
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
import { AssistantSourceScopeSelector } from '@/components/dashboard/settings/assistant-source-scope-selector'
import type { AgentSourceScope, DocumentSourceListItem } from '@/lib/api'
import type { AgentSkill, AgentSkillCapabilityId, AgentSkillCreateInput, SkillCapabilityDescriptor, SkillCapabilitySettingsField } from '@/lib/api-skills'
import { cn } from '@/lib/utils'
import {
  buildAgentSkillInput,
  createInitialSkillDraft,
  deriveSkillFields,
  formatCapabilityLabel,
  formatInvocationMode,
  validateSkillName,
  type SkillFormDraft,
  type SkillInputMode,
  type SkillSettingDraftValue,
} from './skill-form-model'

const modeLabel: Record<SkillInputMode, string> = {
  expose: 'Expose',
  bind: 'Bind',
  ignore: 'Skip',
}

const isSourceScopeDraft = (value: SkillSettingDraftValue): value is AgentSourceScope =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'mode' in value

const sourceTargetsToList = (capability: SkillCapabilityDescriptor | null): DocumentSourceListItem[] =>
  (capability?.targets ?? [])
    .filter((target) => target.id !== 'all')
    .map((target) => ({
      id: target.id,
      name: target.label,
      kind: 'upload',
      externalId: null,
      lastSyncStatus: target.status ?? null,
      lastSyncedAt: null,
      documentCount: 0,
      createdAt: '',
      updatedAt: '',
    }))

const groupedSettingsFields = (fields: readonly SkillCapabilitySettingsField[]) => {
  const groups = new Map<string, SkillCapabilitySettingsField[]>()
  for (const field of fields) {
    const group = field.group ?? 'Settings'
    groups.set(group, [...(groups.get(group) ?? []), field])
  }
  return [...groups.entries()]
}

function SkillSettingControl({
  field,
  value,
  sourceList,
  onChange,
}: {
  field: SkillCapabilitySettingsField
  value: SkillSettingDraftValue
  sourceList: DocumentSourceListItem[]
  onChange: (value: SkillSettingDraftValue) => void
}) {
  const fieldId = `skill-setting-${field.key.replace(/[^a-z0-9_-]/giu, '-')}`

  if (field.type === 'source_scope') {
    return (
      <div className="md:col-span-2">
        <AssistantSourceScopeSelector
          sourceScope={isSourceScopeDraft(value) ? value : { mode: 'all' }}
          sourceList={sourceList}
          onChange={onChange}
        />
      </div>
    )
  }

  if (field.type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
        <div className="space-y-1">
          <Label htmlFor={fieldId}>{field.label}</Label>
          {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
        </div>
        <Switch id={fieldId} checked={value === true} onCheckedChange={onChange} />
      </div>
    )
  }

  if (field.type === 'select') {
    return (
      <div className="space-y-2">
        <Label htmlFor={fieldId}>{field.label}</Label>
        <Select value={typeof value === 'string' ? value : undefined} onValueChange={onChange}>
          <SelectTrigger id={fieldId}>
            <SelectValue placeholder="Choose option" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
      </div>
    )
  }

  if (field.type === 'textarea') {
    return (
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor={fieldId}>{field.label}</Label>
        <Textarea
          id={fieldId}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-24"
        />
        {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
      </div>
    )
  }

  if (field.type === 'string_list') {
    const items = Array.isArray(value) ? value : []
    const updateItem = (index: number, nextValue: string) => {
      const next = [...items]
      next[index] = nextValue
      onChange(next)
    }
    const removeItem = (index: number) => {
      onChange(items.filter((_, itemIndex) => itemIndex !== index))
    }
    return (
      <div className="space-y-2 md:col-span-2">
        <Label>{field.label}</Label>
        <div className="space-y-2">
          {[...items, ''].map((item, index) => (
            <div key={index} className="flex gap-2">
              <Input
                value={item}
                onChange={(event) => updateItem(index, event.target.value)}
                placeholder="name@example.com"
                aria-label={`${field.label} ${index + 1}`}
              />
              {index < items.length ? (
                <Button type="button" variant="outline" onClick={() => removeItem(index)}>
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={fieldId}>{field.label}</Label>
      <Input
        id={fieldId}
        type={field.type === 'number' ? 'number' : 'text'}
        min={field.min}
        max={field.max}
        value={field.type === 'number'
          ? typeof value === 'number' ? String(value) : ''
          : typeof value === 'string' ? value : ''}
        onChange={(event) => {
          if (field.type === 'number') {
            onChange(event.target.value === '' ? undefined : Number(event.target.value))
            return
          }
          onChange(event.target.value)
        }}
      />
      {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
    </div>
  )
}

export function SkillForm({
  open,
  capabilities,
  skills,
  editingSkill = null,
  capabilityId = null,
  isSaving = false,
  error = null,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  capabilities: SkillCapabilityDescriptor[]
  skills: AgentSkill[]
  editingSkill?: AgentSkill | null
  capabilityId?: AgentSkillCapabilityId | null
  isSaving?: boolean
  error?: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (input: AgentSkillCreateInput) => Promise<void>
}) {
  const scopedCapabilities = useMemo(() => {
    if (editingSkill) {
      return capabilities
    }
    return capabilityId ? capabilities.filter((item) => item.id === capabilityId) : capabilities
  }, [capabilities, capabilityId, editingSkill])
  const [draft, setDraft] = useState<SkillFormDraft>(() => createInitialSkillDraft(scopedCapabilities, editingSkill))
  const capability = useMemo(
    () => scopedCapabilities.find((item) => item.id === draft.capabilityId) ?? null,
    [scopedCapabilities, draft.capabilityId],
  )
  const fields = useMemo(() => capability ? deriveSkillFields(capability) : [], [capability])
  const nameError = validateSkillName(draft.name, skills, editingSkill?.id)
  const selectedCapabilityAvailable = Boolean(capability?.available)
  const selectedTarget = capability?.targets.find((target) => target.id === draft.targetId) ?? null
  const targetReady = Boolean(capability && (!(capability.requiresTarget ?? true) || draft.targetId))
  const canSubmit = Boolean(capability && selectedCapabilityAvailable && targetReady && !nameError && draft.invocationMode && !isSaving)

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => {
      setDraft(createInitialSkillDraft(scopedCapabilities, editingSkill))
    })
  }, [editingSkill, open, scopedCapabilities])

  const updateDraft = (patch: Partial<SkillFormDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
  }

  const updateInput = (name: string, patch: Partial<SkillFormDraft['inputDrafts'][string]>) => {
    setDraft((current) => ({
      ...current,
      inputDrafts: {
        ...current.inputDrafts,
        [name]: {
          ...current.inputDrafts[name],
          ...patch,
        },
      },
    }))
  }

  const updateSetting = (key: string, value: SkillSettingDraftValue) => {
    setDraft((current) => ({
      ...current,
      settingDrafts: {
        ...current.settingDrafts,
        [key]: value,
      },
    }))
  }

  const toggleOutcome = (outcome: string, enabled: boolean) => {
    setDraft((current) => {
      const currentOutcomes = new Set(current.selectedOutcomes)
      if (enabled) {
        currentOutcomes.add(outcome)
      } else {
        currentOutcomes.delete(outcome)
      }
      return { ...current, selectedOutcomes: [...currentOutcomes] }
    })
  }

  const submit = async () => {
    if (!capability || !canSubmit) {
      return
    }
    await onSubmit(buildAgentSkillInput(capability, draft, fields))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editingSkill ? 'Edit skill' : `Configure ${capability ? formatCapabilityLabel(capability.id) : 'skill'}`}</DialogTitle>
          <DialogDescription>
            Configure a named capability instance for this agent. Connections and credentials are managed separately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {error ? (
            <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          ) : null}

          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-2">
              <Label>Target</Label>
              <Select
                value={draft.targetId}
                onValueChange={(targetId) => updateDraft({ targetId })}
                disabled={!capability || !capability.available || !(capability.requiresTarget ?? true) || capability.targets.length === 0}
              >
                <SelectTrigger>
                  <SelectValue placeholder={(capability?.requiresTarget ?? true) ? 'Choose target' : 'Inline configuration'} />
                </SelectTrigger>
                <SelectContent>
                  {capability?.targets.map((target) => (
                    <SelectItem key={target.id} value={target.id}>
                      {target.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!(capability?.requiresTarget ?? true) ? (
                <p className="text-xs text-muted-foreground">This capability is configured inline and does not bind to a connection.</p>
              ) : selectedTarget?.status ? (
                <p className="text-xs text-muted-foreground">{selectedTarget.status}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="skill-name">Skill name</Label>
              <Input
                id="skill-name"
                value={draft.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
                placeholder="retrieve_events"
                disabled={Boolean(editingSkill)}
              />
              <p className={cn('text-xs', nameError ? 'text-destructive' : 'text-muted-foreground')}>
                {nameError ?? `Reference this skill as @${draft.name || 'name'} in a routine.`}
              </p>
            </div>

            <div className="space-y-2">
              <Label>Invocation mode</Label>
              <Select
                value={draft.invocationMode}
                onValueChange={(invocationMode) => updateDraft({ invocationMode: invocationMode as SkillFormDraft['invocationMode'] })}
                disabled={!capability}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {capability?.supportedInvocationModes.map((mode) => (
                    <SelectItem key={mode} value={mode}>{formatInvocationMode(mode)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {capability?.inputSchema.source === 'discovered' ? (
            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
              <Label htmlFor="skill-tool-name">Discovered tool name</Label>
              <Input
                id="skill-tool-name"
                value={draft.toolName}
                onChange={(event) => updateDraft({ toolName: event.target.value })}
                placeholder="tool_name"
              />
              <p className="text-xs text-muted-foreground">
                Tool discovery is provided by the connected target. If discovery is unavailable, enter the published tool name and leave inputs empty.
              </p>
            </div>
          ) : null}

          {capability?.settingsFields.length ? (
            <div className="space-y-3">
              <div>
                <h4 className="text-sm font-medium text-foreground">Settings</h4>
                <p className="text-xs text-muted-foreground">
                  Configure author-owned behavior for this capability.
                </p>
              </div>
              <div className="space-y-4">
                {groupedSettingsFields(capability.settingsFields).map(([group, groupFields]) => (
                  <div key={group} className="space-y-3 rounded-md border border-border p-3">
                    <h5 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</h5>
                    <div className="grid gap-3 md:grid-cols-2">
                      {groupFields.map((field) => (
                        <SkillSettingControl
                          key={field.key}
                          field={field}
                          value={draft.settingDrafts[field.key]}
                          sourceList={sourceTargetsToList(capability)}
                          onChange={(value) => updateSetting(field.key, value)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            <div>
              <h4 className="text-sm font-medium text-foreground">Inputs</h4>
              <p className="text-xs text-muted-foreground">
                Bind values the author fixes now, expose values the routine supplies later, or skip optional fields.
              </p>
            </div>
            {fields.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                This capability did not publish static inputs.
              </p>
            ) : (
              <div className="divide-y divide-border rounded-md border border-border">
                {fields.map((field) => {
                  const fieldDraft = draft.inputDrafts[field.name]
                  return (
                    <div key={field.name} className="grid gap-3 p-3 md:grid-cols-[minmax(0,10rem)_8rem_minmax(0,1fr)]">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">{field.name}</p>
                          {field.required ? <Badge variant="outline">Required</Badge> : null}
                        </div>
                        <p className="text-xs text-muted-foreground">{field.description ?? field.type}</p>
                      </div>
                      <Select
                        value={fieldDraft?.mode ?? 'ignore'}
                        onValueChange={(mode) => updateInput(field.name, { mode: mode as SkillInputMode })}
                      >
                        <SelectTrigger aria-label={field.name}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="expose">{modeLabel.expose}</SelectItem>
                          <SelectItem value="bind">{modeLabel.bind}</SelectItem>
                          <SelectItem value="ignore">{modeLabel.ignore}</SelectItem>
                        </SelectContent>
                      </Select>
                      {fieldDraft?.mode === 'bind' ? (
                        <Input
                          value={fieldDraft.boundValue}
                          onChange={(event) => updateInput(field.name, { boundValue: event.target.value })}
                          placeholder={field.name}
                        />
                      ) : fieldDraft?.mode === 'expose' ? (
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Input
                            value={fieldDraft.slotBinding}
                            onChange={(event) => updateInput(field.name, { slotBinding: event.target.value })}
                            placeholder={field.name}
                            aria-label={`${field.name} slot`}
                          />
                          <Input
                            value={fieldDraft.description}
                            onChange={(event) => updateInput(field.name, { description: event.target.value })}
                            placeholder="Runtime prompt label"
                            aria-label={`${field.name} description`}
                          />
                        </div>
                      ) : (
                        <p className="self-center text-sm text-muted-foreground">Not included</p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <h4 className="text-sm font-medium text-foreground">Declared outcomes</h4>
              <p className="text-xs text-muted-foreground">Structured statuses routines can branch on.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {capability?.outcomeVocabulary.map((outcome) => (
                <button
                  key={outcome}
                  type="button"
                  onClick={() => toggleOutcome(outcome, !draft.selectedOutcomes.includes(outcome))}
                  className={cn(
                    'inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors',
                    draft.selectedOutcomes.includes(outcome)
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border bg-background text-muted-foreground hover:text-foreground',
                  )}
                >
                  {draft.selectedOutcomes.includes(outcome) ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  {outcome}
                </button>
              ))}
            </div>
          </div>

          {draft.extraConfigJson.trim() !== '{}' ? (
            <div className="space-y-2">
              <Label htmlFor="skill-extra-config">Advanced config JSON</Label>
              <Textarea
                id="skill-extra-config"
                value={draft.extraConfigJson}
                onChange={(event) => updateDraft({ extraConfigJson: event.target.value })}
                className="min-h-28 font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Preserves config keys this descriptor does not publish as typed settings.
              </p>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
            <div>
              <Label htmlFor="skill-enabled">Enabled</Label>
              <p className="text-xs text-muted-foreground">Disabled skills stay configured but cannot run.</p>
            </div>
            <Switch id="skill-enabled" checked={draft.enabled} onCheckedChange={(enabled) => updateDraft({ enabled })} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>
            {isSaving ? <Spinner className="h-4 w-4" /> : <Wrench className="h-4 w-4" />}
            {editingSkill ? 'Save skill' : 'Create skill'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
