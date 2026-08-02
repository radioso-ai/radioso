'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronDown, Plus, RefreshCw, Wrench } from 'lucide-react'

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
import { MetadataRulesEditor } from '@/components/dashboard/settings/metadata-rules-editor'
import type { AgentSourceScope, DocumentSourceListItem, RetrievalMetadataRule } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { externalSkillsApi } from '@/lib/api-external-skills'
import type { AgentSkill, AgentSkillCapabilityId, AgentSkillCreateInput, SkillCapabilityDescriptor, SkillCapabilitySettingsField } from '@/lib/api-skills'
import type { DiscoveredMcpTool } from '@/lib/external-skills'
import { cn } from '@/lib/utils'
import {
  buildAgentSkillInput,
  createInputDrafts,
  createInitialSkillDraft,
  deriveSkillFields,
  formatCapabilityLabel,
  formatInputMode,
  formatInvocationMode,
  validateSkillName,
  type SkillFormDraft,
  type SkillInputMode,
  type SkillSettingDraftValue,
} from './skill-form-model'

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
      documentEnrichmentOverride: 'inherit',
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

const DEFAULT_SELECT_VALUE = '__default__'

const preserveInputDrafts = (
  nextDrafts: SkillFormDraft['inputDrafts'],
  currentDrafts: SkillFormDraft['inputDrafts'],
): SkillFormDraft['inputDrafts'] =>
  Object.fromEntries(
    Object.entries(nextDrafts).map(([name, nextDraft]) => [name, currentDrafts[name] ?? nextDraft]),
  )

const optionLabel = (field: SkillCapabilitySettingsField, value: unknown): string | null =>
  typeof value === 'string'
    ? field.options?.find((option) => option.value === value)?.label ?? value
    : null

const formatDefaultValue = (field: SkillCapabilitySettingsField): string | null => {
  if (field.defaultValue === undefined) return null
  if (field.type === 'select') return optionLabel(field, field.defaultValue)
  if (typeof field.defaultValue === 'boolean') return field.defaultValue ? 'On' : 'Off'
  return String(field.defaultValue)
}

const isParentEffectivelyEnabled = (
  parent: SkillCapabilitySettingsField | undefined,
  settingDrafts: Record<string, SkillSettingDraftValue>,
): boolean => {
  if (!parent || parent.type !== 'boolean') return false
  const value = settingDrafts[parent.key]
  return typeof value === 'boolean' ? value : parent.defaultValue === true
}

const visibleSettingRows = (
  fields: readonly SkillCapabilitySettingsField[],
  settingDrafts: Record<string, SkillSettingDraftValue>,
): Array<{ field: SkillCapabilitySettingsField; nested: boolean }> => {
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const childrenByParent = new Map<string, SkillCapabilitySettingsField[]>()
  const childKeys = new Set<string>()

  for (const field of fields) {
    if (!field.dependsOnKey) continue
    childKeys.add(field.key)
    childrenByParent.set(field.dependsOnKey, [...(childrenByParent.get(field.dependsOnKey) ?? []), field])
  }

  const rows: Array<{ field: SkillCapabilitySettingsField; nested: boolean }> = []
  for (const field of fields) {
    if (childKeys.has(field.key)) continue
    rows.push({ field, nested: false })
    if (!isParentEffectivelyEnabled(field, settingDrafts)) continue
    for (const child of childrenByParent.get(field.key) ?? []) {
      rows.push({ field: child, nested: true })
    }
  }

  for (const field of fields) {
    if (!field.dependsOnKey || byKey.has(field.dependsOnKey)) continue
    rows.push({ field, nested: false })
  }

  return rows
}

const shouldShowGroupHeading = (
  group: string,
  fields: readonly SkillCapabilitySettingsField[],
): boolean =>
  !(fields.length === 1 && fields[0]?.type === 'boolean' && fields[0].label === group)

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
  const defaultValue = formatDefaultValue(field)

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
    const hasOverride = typeof value === 'boolean'
    return (
      <div className="flex items-center justify-between gap-3 rounded-md bg-muted/20 px-3 py-2">
        <div className="space-y-1">
          <Label htmlFor={fieldId}>{field.label}</Label>
          {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
          {!hasOverride && field.defaultValue !== undefined ? (
            <p className="text-xs text-muted-foreground">Default: {defaultValue}</p>
          ) : null}
          {hasOverride && field.defaultValue !== undefined ? (
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-xs text-muted-foreground"
              onClick={() => onChange(undefined)}
            >
              Reset to default
            </Button>
          ) : null}
        </div>
        <Switch
          id={fieldId}
          checked={hasOverride ? value : field.defaultValue === true}
          onCheckedChange={onChange}
        />
      </div>
    )
  }

  if (field.type === 'select') {
    const selectedDefaultLabel = optionLabel(field, field.defaultValue)
    const selectValue = typeof value === 'string' ? value : DEFAULT_SELECT_VALUE
    return (
      <div className="space-y-2">
        <Label htmlFor={fieldId}>{field.label}</Label>
        <Select
          value={selectValue}
          onValueChange={(nextValue) => onChange(nextValue === DEFAULT_SELECT_VALUE ? undefined : nextValue)}
        >
          <SelectTrigger id={fieldId}>
            <SelectValue placeholder={selectedDefaultLabel ? `Default (${selectedDefaultLabel})` : 'Choose option'}>
              {selectValue === DEFAULT_SELECT_VALUE
                ? selectedDefaultLabel ? `Default (${selectedDefaultLabel})` : 'Choose option'
                : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_SELECT_VALUE}>
              {selectedDefaultLabel ? `Use default (${selectedDefaultLabel})` : 'Choose option'}
            </SelectItem>
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
    const defaultText = typeof field.defaultValue === 'string' ? field.defaultValue : null
    const hasOverride = typeof value === 'string'
    const tallDefault = defaultText !== null && defaultText.length > 200

    if (defaultText !== null && !hasOverride) {
      return (
        <div className="space-y-2 md:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={fieldId}>{field.label}</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Override ${field.label}`}
              onClick={() => onChange(defaultText)}
            >
              Override
            </Button>
          </div>
          <Textarea
            id={fieldId}
            value={defaultText}
            disabled
            className={cn('min-h-24', tallDefault ? 'min-h-56' : '')}
          />
          <p className="text-xs text-muted-foreground">Default shown. Override to edit it for this skill.</p>
          {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
        </div>
      )
    }

    return (
      <div className="space-y-2 md:col-span-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={fieldId}>{field.label}</Label>
          {defaultText !== null ? (
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-xs text-muted-foreground"
              onClick={() => onChange(undefined)}
            >
              Reset to default
            </Button>
          ) : null}
        </div>
        <Textarea
          id={fieldId}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          className={cn('min-h-24', tallDefault ? 'min-h-56' : '')}
        />
        {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
      </div>
    )
  }

  if (field.type === 'string_list') {
    const items = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
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

  if (field.type === 'metadata_rules') {
    const rules = Array.isArray(value) ? (value as RetrievalMetadataRule[]) : []
    return (
      <div className="space-y-2 md:col-span-2">
        <Label>{field.label}</Label>
        {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
        <MetadataRulesEditor
          metadataRules={rules}
          metadataFieldSuggestions={[]}
          onChange={(next) => onChange(next)}
          showHeader={false}
        />
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
        placeholder={field.type === 'number' && field.defaultValue !== undefined ? `Default: ${field.defaultValue}` : undefined}
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
  agentId,
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
  agentId: string
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
  const [draft, setDraft] = useState<SkillFormDraft>(() => createInitialSkillDraft(scopedCapabilities, editingSkill, skills))
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [routineOpen, setRoutineOpen] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [discoveredTools, setDiscoveredTools] = useState<DiscoveredMcpTool[]>([])
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [discoveryUnavailable, setDiscoveryUnavailable] = useState(false)
  const discoveryRequestId = useRef(0)
  const capability = useMemo(
    () => scopedCapabilities.find((item) => item.id === draft.capabilityId) ?? null,
    [scopedCapabilities, draft.capabilityId],
  )
  const selectedTool = useMemo(
    () => discoveredTools.find((tool) => tool.name === draft.toolName) ?? null,
    [discoveredTools, draft.toolName],
  )
  const fields = useMemo(
    () => capability ? deriveSkillFields(capability, selectedTool?.inputSchema) : [],
    [capability, selectedTool],
  )
  const nameError = validateSkillName(draft.name, skills, editingSkill?.id)
  const selectedCapabilityAvailable = Boolean(capability?.available)
  const selectedTarget = capability?.targets.find((target) => target.id === draft.targetId) ?? null
  const targetReady = Boolean(capability && (!(capability.requiresTarget ?? true) || draft.targetId))
  const canUsePersistedDiscoveredConfig = Boolean(
    editingSkill
      && capability?.inputSchema.source === 'discovered'
      && discoveryUnavailable
      && editingSkill.target.id === draft.targetId
      && typeof editingSkill.config.toolName === 'string'
      && editingSkill.config.toolName === draft.toolName,
  )
  const discoveryReady = capability?.inputSchema.source !== 'discovered'
    || Boolean(!isDiscovering && (selectedTool || canUsePersistedDiscoveredConfig))
  const canSubmit = Boolean(capability && selectedCapabilityAvailable && targetReady && discoveryReady && !nameError && draft.invocationMode && !isSaving)
  const essentialSettingsFields = useMemo(
    () => capability?.settingsFields.filter((field) => field.advanced !== true) ?? [],
    [capability],
  )
  const advancedSettingsFields = useMemo(
    () => capability?.settingsFields.filter((field) => field.advanced === true) ?? [],
    [capability],
  )

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => {
      setDraft(createInitialSkillDraft(scopedCapabilities, editingSkill, skills))
      setAdvancedOpen(false)
      setRoutineOpen(false)
      setLocalError(null)
    })
  }, [editingSkill, open, scopedCapabilities, skills])

  const discoverTools = useCallback(async (connectionId: string, preferredToolName: string) => {
    if (!capability || capability.inputSchema.source !== 'discovered') return

    const requestId = discoveryRequestId.current + 1
    discoveryRequestId.current = requestId
    setIsDiscovering(true)
    setDiscoveryError(null)
    setDiscoveryUnavailable(false)
    try {
      const response = await externalSkillsApi.discoverTools(agentId, connectionId)
      if (discoveryRequestId.current !== requestId) return

      const selected = response.tools.find((tool) => tool.name === preferredToolName)
        ?? (preferredToolName ? null : response.tools[0])
        ?? null
      const configuredToolMissing = Boolean(preferredToolName && !selected)
      const existingConfig = editingSkill?.target.id === connectionId
        && editingSkill.config.toolName === selected?.name
        ? editingSkill.config
        : undefined
      const nextFields = deriveSkillFields(capability, selected?.inputSchema)

      setDiscoveredTools(response.tools)
      setDiscoveryError(response.tools.length === 0
        ? 'This connection did not publish any MCP tools.'
        : configuredToolMissing
          ? `The configured tool “${preferredToolName}” is no longer published by this connection. Choose a replacement tool to continue.`
          : null)
      setDraft((current) => current.targetId === connectionId
        ? {
            ...current,
            toolName: selected?.name ?? '',
            inputDrafts: preserveInputDrafts(
              createInputDrafts(nextFields, existingConfig),
              current.inputDrafts,
            ),
          }
        : current)
    } catch (discoverError) {
      if (discoveryRequestId.current !== requestId) return
      setDiscoveredTools([])
      setDiscoveryError(getApiErrorMessage(discoverError, 'Failed to discover MCP tools.'))
      setDiscoveryUnavailable(true)
    } finally {
      if (discoveryRequestId.current === requestId) {
        setIsDiscovering(false)
      }
    }
  }, [agentId, capability, editingSkill])

  useEffect(() => {
    if (!open || !capability || capability.inputSchema.source !== 'discovered' || !draft.targetId) {
      discoveryRequestId.current += 1
      queueMicrotask(() => {
        setDiscoveredTools([])
        setDiscoveryError(null)
        setDiscoveryUnavailable(false)
        setIsDiscovering(false)
      })
      return
    }

    // Discovery is tied to the connection. Tool changes use the already fetched
    // schemas and must not trigger another network request.
    queueMicrotask(() => {
      void discoverTools(draft.targetId, draft.toolName)
    })
    return () => {
      discoveryRequestId.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capability, discoverTools, draft.targetId, open])

  const updateDraft = (patch: Partial<SkillFormDraft>) => {
    setLocalError(null)
    setDraft((current) => ({ ...current, ...patch }))
  }

  const updateInput = (name: string, patch: Partial<SkillFormDraft['inputDrafts'][string]>) => {
    setLocalError(null)
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

  const updateTarget = (targetId: string) => {
    if (capability?.inputSchema.source === 'discovered') {
      discoveryRequestId.current += 1
      setDiscoveredTools([])
      setDiscoveryError(null)
      setDiscoveryUnavailable(false)
      updateDraft({ targetId, toolName: '', inputDrafts: {} })
      return
    }
    updateDraft({ targetId })
  }

  const selectDiscoveredTool = (toolName: string) => {
    if (!capability) return
    if (toolName === draft.toolName) return
    const tool = discoveredTools.find((candidate) => candidate.name === toolName)
    if (!tool) return
    const existingConfig = editingSkill?.target.id === draft.targetId
      && editingSkill.config.toolName === toolName
      ? editingSkill.config
      : undefined
    setDiscoveryError(null)
    updateDraft({
      toolName,
      inputDrafts: createInputDrafts(deriveSkillFields(capability, tool.inputSchema), existingConfig),
    })
  }

  const updateSetting = (key: string, value: SkillSettingDraftValue) => {
    setLocalError(null)
    setDraft((current) => ({
      ...current,
      settingDrafts: {
        ...current.settingDrafts,
        [key]: value,
      },
    }))
  }

  const toggleOutcome = (outcome: string, enabled: boolean) => {
    setLocalError(null)
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
    let input: AgentSkillCreateInput
    try {
      input = buildAgentSkillInput(capability, draft, fields)
      if (canUsePersistedDiscoveredConfig && editingSkill) {
        input = {
          ...input,
          config: {
            ...input.config,
            toolName: editingSkill.config.toolName,
            boundParams: editingSkill.config.boundParams ?? {},
            exposedParams: editingSkill.config.exposedParams ?? {},
          },
        }
      }
    } catch (buildError) {
      setLocalError(buildError instanceof Error ? buildError.message : 'Invalid skill configuration.')
      return
    }
    setLocalError(null)
    await onSubmit(input)
  }

  const displayedError = localError ?? error
  const renderSettingsGroups = (settingsFields: readonly SkillCapabilitySettingsField[]) => {
    if (!capability || settingsFields.length === 0) return null

    return (
      <div className="space-y-5">
        {groupedSettingsFields(settingsFields).map(([group, groupFields], index) => (
          <div key={group} className={cn('space-y-3', index > 0 ? 'border-t border-border pt-4' : '')}>
            {shouldShowGroupHeading(group, groupFields) ? (
              <h5 className="text-sm font-medium text-foreground">{group}</h5>
            ) : null}
            <div className="grid gap-3 md:grid-cols-2">
              {visibleSettingRows(groupFields, draft.settingDrafts).map(({ field, nested }) => (
                <div
                  key={field.key}
                  className={cn(
                    field.type === 'source_scope' || field.type === 'textarea' || field.type === 'string_list' || field.type === 'metadata_rules'
                      ? 'md:col-span-2'
                      : '',
                    nested ? 'border-l border-border pl-4 md:col-span-2' : '',
                  )}
                >
                  <SkillSettingControl
                    field={field}
                    value={draft.settingDrafts[field.key]}
                    sourceList={sourceTargetsToList(capability)}
                    onChange={(value) => updateSetting(field.key, value)}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    )
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
          {displayedError ? (
            <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {displayedError}
            </p>
          ) : null}

          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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

            {(capability?.requiresTarget ?? true) ? (
              <div className="space-y-2">
                <Label htmlFor="skill-target">Target</Label>
                <Select
                  value={draft.targetId}
                  onValueChange={updateTarget}
                  disabled={!capability || !capability.available || capability.targets.length === 0}
                >
                  <SelectTrigger id="skill-target">
                    <SelectValue placeholder="Choose target" />
                  </SelectTrigger>
                  <SelectContent>
                    {capability?.targets.map((target) => (
                      <SelectItem key={target.id} value={target.id}>
                        {target.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedTarget?.status ? (
                  <p className="text-xs text-muted-foreground">{selectedTarget.status}</p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/20 px-3 py-2">
            <Label htmlFor="skill-enabled">Enabled</Label>
            <Switch id="skill-enabled" checked={draft.enabled} onCheckedChange={(enabled) => updateDraft({ enabled })} />
          </div>

          {capability?.inputSchema.source === 'discovered' ? (
            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="skill-tool-name">MCP tool</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void discoverTools(draft.targetId, draft.toolName)}
                  disabled={!draft.targetId || isDiscovering}
                >
                  {isDiscovering ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
                  Refresh tools
                </Button>
              </div>
              {discoveredTools.length > 0 ? (
                <Select value={draft.toolName} onValueChange={selectDiscoveredTool} disabled={isDiscovering}>
                  <SelectTrigger id="skill-tool-name">
                    <SelectValue placeholder="Choose a discovered tool" />
                  </SelectTrigger>
                  <SelectContent>
                    {discoveredTools.map((tool) => (
                      <SelectItem key={tool.name} value={tool.name}>{tool.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : isDiscovering ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="h-4 w-4" />
                  Discovering tools...
                </p>
              ) : null}
              {selectedTool?.description ? <p className="text-xs text-muted-foreground">{selectedTool.description}</p> : null}
              {discoveryError ? <p className="text-sm text-destructive" role="alert">{discoveryError}</p> : null}
            </div>
          ) : null}

          {essentialSettingsFields.length ? (
            renderSettingsGroups(essentialSettingsFields)
          ) : null}

          <div className="rounded-md border border-border">
            <button
              type="button"
              onClick={() => setAdvancedOpen((current) => !current)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm font-medium text-foreground"
              aria-expanded={advancedOpen}
            >
              Advanced
              <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', advancedOpen ? 'rotate-180' : '')} />
            </button>
            {advancedOpen ? (
              <div className="space-y-5 border-t border-border p-3">
                <div className="space-y-2">
                  <Label htmlFor="skill-invocation-mode">When to use</Label>
                  <Select
                    value={draft.invocationMode}
                    onValueChange={(invocationMode) => updateDraft({ invocationMode: invocationMode as SkillFormDraft['invocationMode'] })}
                    disabled={!capability}
                  >
                    <SelectTrigger id="skill-invocation-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {capability?.supportedInvocationModes.map((mode) => (
                        <SelectItem key={mode} value={mode}>{formatInvocationMode(mode)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {advancedSettingsFields.length ? renderSettingsGroups(advancedSettingsFields) : null}
              </div>
            ) : null}
          </div>

          <div className="rounded-md border border-border">
            <button
              type="button"
              onClick={() => setRoutineOpen((current) => !current)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm font-medium text-foreground"
              aria-expanded={routineOpen}
            >
              <span className="space-y-1">
                <span className="block">Routine integration</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  These only matter when the skill is invoked from a routine or selected by the agent.
                </span>
              </span>
              <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', routineOpen ? 'rotate-180' : '')} />
            </button>
            {routineOpen ? (
              <div className="space-y-5 border-t border-border p-3">
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-foreground">Inputs</h4>
                  {capability?.inputSchema.source === 'discovered' && isDiscovering ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground">
                      Loading tool schema…
                    </p>
                  ) : capability?.inputSchema.source === 'discovered' && !selectedTool ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground">
                      {canUsePersistedDiscoveredConfig
                        ? 'Saved tool inputs will be preserved when this skill is saved.'
                        : 'Choose a discovered MCP tool to configure its inputs.'}
                    </p>
                  ) : fields.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground">
                      No inputs are published for this capability.
                    </p>
                  ) : (
                    <div className="divide-y divide-border">
                      {fields.map((field) => {
                        const fieldDraft = draft.inputDrafts[field.name]
                        return (
                          <div key={field.name} className="grid gap-3 p-3 md:grid-cols-[minmax(0,10rem)_11rem_minmax(0,1fr)]">
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
                                <SelectItem value="expose">{formatInputMode('expose')}</SelectItem>
                                <SelectItem value="bind">{formatInputMode('bind')}</SelectItem>
                                <SelectItem value="ignore">{formatInputMode('ignore')}</SelectItem>
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
                                <div className="space-y-1">
                                  <Label className="text-xs text-muted-foreground">Slot</Label>
                                  <Input
                                    value={fieldDraft.slotBinding}
                                    onChange={(event) => updateInput(field.name, { slotBinding: event.target.value })}
                                    placeholder={field.name}
                                    aria-label={`${field.name} slot`}
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs text-muted-foreground">Description shown to the agent</Label>
                                  <Input
                                    value={fieldDraft.description}
                                    onChange={(event) => updateInput(field.name, { description: event.target.value })}
                                    placeholder="Label shown to the agent"
                                    aria-label={`${field.name} description`}
                                  />
                                </div>
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
                  <h4 className="text-sm font-medium text-foreground">Outcomes</h4>
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

                <div className="space-y-2">
                  <Label htmlFor="skill-extra-config">Advanced config JSON</Label>
                  <Textarea
                    id="skill-extra-config"
                    value={draft.extraConfigJson}
                    onChange={(event) => updateDraft({ extraConfigJson: event.target.value })}
                    className="min-h-28 font-mono text-xs"
                  />
                </div>
              </div>
            ) : null}
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
