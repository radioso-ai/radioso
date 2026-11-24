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
import { settingsApi } from '@/lib/api'
import type {
  MetadataFieldSuggestion,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { externalSkillsApi } from '@/lib/api-external-skills'
import { routineSkillCatalogApi } from '@/lib/api-routine-skill-catalog'
import type { AgentSkill, AgentSkillCapabilityId, AgentSkillCreateInput, SkillCapabilityDescriptor, SkillCapabilitySettingsField } from '@/lib/api-skills'
import type { DiscoveredMcpTool } from '@/lib/external-skills'
import { cn } from '@/lib/utils'
import { ApiRequestFields } from './ApiRequestFields'
import { createApiRequestDraft } from './api-request-skill-model'
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
import {
  groupedSettingsFields,
  preserveInputDrafts,
  shouldShowGroupHeading,
  SkillSettingControl,
  sourceTargetsToList,
  visibleSettingRows,
  type RecipientState,
} from './SkillSettingControl'


export function SkillForm({
  agentId,
  open,
  capabilities,
  skills,
  editingSkill = null,
  capabilityId = null,
  initialName = null,
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
  // Seeds the name for a new skill instead of the capability's suggestion, for a caller that
  // already knows what the author called it.
  initialName?: string | null
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
  const buildDraft = useCallback((): SkillFormDraft => {
    const initial = createInitialSkillDraft(scopedCapabilities, editingSkill, skills)
    return !editingSkill && initialName ? { ...initial, name: initialName } : initial
  }, [editingSkill, initialName, scopedCapabilities, skills])
  const [draft, setDraft] = useState<SkillFormDraft>(buildDraft)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [routineOpen, setRoutineOpen] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [metadataFieldSuggestions, setMetadataFieldSuggestions] = useState<MetadataFieldSuggestion[]>([])
  const [discoveredTools, setDiscoveredTools] = useState<DiscoveredMcpTool[]>([])
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [discoveryUnavailable, setDiscoveryUnavailable] = useState(false)
  const [recipientStates, setRecipientStates] = useState<Map<string, RecipientState>>(new Map())
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
      setDraft(buildDraft())
      setAdvancedOpen(false)
      setRoutineOpen(false)
      setLocalError(null)
    })
  }, [buildDraft, open])

  // Metadata-rule field suggestions: the document type catalog's declarations
  // unioned with the keys already observed on document metadata. Loaded with the
  // form because it is the only place in this dialog that needs them, and a
  // failure here costs autocomplete rather than the edit.
  useEffect(() => {
    if (!open) return

    let active = true
    const loadSuggestions = async () => {
      try {
        const defaults = await settingsApi.getRetrievalDefaults()
        if (!active) return
        setMetadataFieldSuggestions(defaults.metadataFieldSuggestions ?? [])
      } catch (error) {
        console.error('Failed to load metadata field suggestions:', error)
      }
    }
    void loadSuggestions()
    return () => {
      active = false
    }
  }, [open])

  useEffect(() => {
    if (!open || capability?.id !== 'notify' || !editingSkill) {
      queueMicrotask(() => setRecipientStates(new Map()))
      return
    }
    let active = true
    void routineSkillCatalogApi.listNotifySkillRecipients(agentId, editingSkill.id).then((recipients) => {
      if (!active) return
      setRecipientStates(new Map(recipients.map((recipient) => [recipient.email.toLowerCase(), recipient.state])))
    }).catch(() => {
      if (active) setRecipientStates(new Map())
    })
    return () => { active = false }
  }, [agentId, capability?.id, editingSkill, open])

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
                    allFields={settingsFields}
                    settingDrafts={draft.settingDrafts}
                    sourceList={sourceTargetsToList(capability)}
                    metadataFieldSuggestions={metadataFieldSuggestions}
                    onChange={(value) => updateSetting(field.key, value)}
                    recipientStates={field.key === 'delivery.recipientEmails' ? recipientStates : undefined}
                    onResendConfirmation={field.key === 'delivery.recipientEmails'
                      ? (email) => routineSkillCatalogApi.resendNotificationRecipientConfirmationResult(agentId, email)
                      : undefined}
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
      {/* The body scrolls between a fixed header and footer, so Save stays in view, and its width
          is the dialog's: a long response value truncates instead of widening the dialog. */}
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editingSkill ? 'Edit skill' : `Configure ${capability ? formatCapabilityLabel(capability.id) : 'skill'}`}</DialogTitle>
          <DialogDescription>
            Configure a named capability instance for this agent. Connections and credentials are managed separately.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto px-6">
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
                <Label htmlFor="skill-target">{capability?.id === 'api_request' ? 'Connection' : 'Target'}</Label>
                <Select
                  value={draft.targetId}
                  onValueChange={updateTarget}
                  disabled={!capability || !capability.available || capability.targets.length === 0}
                >
                  <SelectTrigger id="skill-target">
                    <SelectValue placeholder={capability?.id === 'api_request' ? 'Choose connection' : 'Choose target'} />
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
                  disabled={!draft.targetId}
                  loading={isDiscovering} icon={<RefreshCw />}
                >
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

          {capability?.id === 'api_request' ? (
            draft.targetId ? (
              <ApiRequestFields
                key={draft.targetId}
                connectionId={draft.targetId}
                draft={draft.apiRequest ?? createApiRequestDraft()}
                onChange={(apiRequest) => updateDraft({ apiRequest })}
              />
            ) : null
          ) : null}

          {essentialSettingsFields.length ? (
            renderSettingsGroups(essentialSettingsFields)
          ) : null}

          {capability?.id !== 'api_request' ? (
            <>
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
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!canSubmit} loading={isSaving} icon={<Wrench />}>
            {editingSkill ? 'Save skill' : 'Create skill'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
