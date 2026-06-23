'use client'

import { useCallback, useEffect, useState } from 'react'
import { CircleSlash, Pencil, Trash2, Wrench } from 'lucide-react'

import { useRegisterAddSkillAction } from '@/components/dashboard/shared/skills-header-action'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { getApiErrorMessage } from '@/lib/api-error'
import { agentSkillsApi, type AgentSkill, type AgentSkillCapabilityId, type AgentSkillCreateInput, type SkillCapabilityDescriptor } from '@/lib/api-skills'
import { cn } from '@/lib/utils'
import { SkillForm } from './SkillForm'
import { formatCapabilityLabel, formatInvocationMode } from './skill-form-model'

const targetLabel = (skill: AgentSkill, capabilities: readonly SkillCapabilityDescriptor[]) => {
  const capability = capabilities.find((candidate) => candidate.id === skill.capability)
  if (capability && !(capability.requiresTarget ?? true)) {
    return 'Inline configuration'
  }
  const target = capability?.targets.find((candidate) => candidate.id === skill.target.id)
  return target?.label ?? skill.target.id ?? skill.target.kind
}

const enabledTone = (enabled: boolean) =>
  enabled ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'

const unavailableReasonLabel = (capability: SkillCapabilityDescriptor) => {
  if (capability.unavailableReason === 'no_connection') {
    return 'Needs connection'
  }
  return capability.unavailableReason ?? 'Unavailable'
}

const capabilityDescription = (capability: SkillCapabilityDescriptor) => {
  const inputCount = capability.inputSchema.source === 'static' && Array.isArray(capability.inputSchema.schema.fields)
    ? capability.inputSchema.schema.fields.length
    : null
  const targetSummary = (capability.requiresTarget ?? true)
    ? `${capability.targets.length} ${capability.targets.length === 1 ? 'target' : 'targets'}`
    : 'Config-only'
  const inputSummary = inputCount === null
    ? 'Discovered inputs'
    : `${inputCount} ${inputCount === 1 ? 'input' : 'inputs'}`
  return `${targetSummary} · ${inputSummary}`
}

function CapabilityPicker({
  open,
  capabilities,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  capabilities: SkillCapabilityDescriptor[]
  onOpenChange: (open: boolean) => void
  onSelect: (capabilityId: AgentSkillCapabilityId) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add new skill</DialogTitle>
          <DialogDescription>
            Choose the capability type to configure. Connection-backed capabilities unlock when their setup exists.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {capabilities.map((capability) => {
            const enabled = capability.available
            return (
              <button
                key={capability.id}
                type="button"
                disabled={!enabled}
                onClick={() => onSelect(capability.id)}
                className={cn(
                  'flex aspect-square min-h-36 flex-col justify-between rounded-md border p-4 text-left transition-colors',
                  enabled
                    ? 'border-border bg-background hover:border-primary/60 hover:bg-muted/30'
                    : 'cursor-not-allowed border-border/70 bg-muted/20 text-muted-foreground opacity-70',
                )}
              >
                <span className="space-y-3">
                  <span className={cn(
                    'inline-flex h-9 w-9 items-center justify-center rounded-md border',
                    enabled ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground',
                  )}>
                    {enabled ? <Wrench className="h-4 w-4" /> : <CircleSlash className="h-4 w-4" />}
                  </span>
                  <span className="block">
                    <span className="block text-sm font-medium text-foreground">{formatCapabilityLabel(capability.id)}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{capabilityDescription(capability)}</span>
                  </span>
                </span>
                <span className="mt-3 flex items-center justify-between gap-2 text-xs">
                  {enabled ? (
                    <Badge variant="secondary">Ready</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">{unavailableReasonLabel(capability)}</Badge>
                  )}
                  {!enabled && (capability.requiresTarget ?? true) ? (
                    <span className="text-muted-foreground">Connections</span>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function SkillList({ agentId }: { agentId: string }) {
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [capabilities, setCapabilities] = useState<SkillCapabilityDescriptor[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [editingSkill, setEditingSkill] = useState<AgentSkill | null>(null)
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<AgentSkillCapabilityId | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [capabilityResponse, skillResponse] = await Promise.all([
        agentSkillsApi.getSkillCapabilities(agentId),
        agentSkillsApi.listSkills(agentId),
      ])
      setCapabilities(capabilityResponse.capabilities)
      setSkills(skillResponse.skills)
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Failed to load skills.'))
    } finally {
      setIsLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    queueMicrotask(() => {
      void load()
    })
  }, [load])

  const openCreate = useCallback(() => {
    setEditingSkill(null)
    setSelectedCapabilityId(null)
    setPickerOpen(true)
  }, [])

  useRegisterAddSkillAction(openCreate)

  const selectCapability = (capabilityId: AgentSkillCapabilityId) => {
    setSelectedCapabilityId(capabilityId)
    setPickerOpen(false)
    setFormOpen(true)
  }

  const openEdit = (skill: AgentSkill) => {
    setEditingSkill(skill)
    setSelectedCapabilityId(null)
    setFormOpen(true)
  }

  const submitSkill = async (input: AgentSkillCreateInput) => {
    setBusyAction('save')
    setError(null)
    try {
      if (editingSkill) {
        await agentSkillsApi.updateSkill(agentId, editingSkill.id, {
          target: input.target,
          config: input.config,
          invocationMode: input.invocationMode,
          enabled: input.enabled,
        })
      } else {
        await agentSkillsApi.createSkill(agentId, input)
      }
      setFormOpen(false)
      setEditingSkill(null)
      setSelectedCapabilityId(null)
      await load()
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'Failed to save skill.'))
    } finally {
      setBusyAction(null)
    }
  }

  const toggleSkill = async (skill: AgentSkill, enabled: boolean) => {
    setBusyAction(`toggle:${skill.id}`)
    setError(null)
    try {
      const response = await agentSkillsApi.updateSkill(agentId, skill.id, { enabled })
      setSkills((current) => current.map((item) => item.id === skill.id ? response.skill : item))
    } catch (updateError) {
      setError(getApiErrorMessage(updateError, 'Failed to update skill.'))
    } finally {
      setBusyAction(null)
    }
  }

  const deleteSkill = async (skill: AgentSkill) => {
    setBusyAction(`delete:${skill.id}`)
    setError(null)
    try {
      await agentSkillsApi.deleteSkill(agentId, skill.id)
      setSkills((current) => current.filter((item) => item.id !== skill.id))
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete skill.'))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <section id="assistant-skills-list" className="space-y-4 scroll-mt-24">
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          Loading skills...
        </div>
      ) : null}

      {!isLoading && skills.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No skills yet. Add a named skill by choosing a capability type.
        </div>
      ) : null}

      {skills.length > 0 ? (
        <ul className="space-y-3">
          {skills.map((skill) => (
            <li key={skill.id}>
              <article className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 shadow-sm">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium text-foreground">@{skill.name}</span>
                    <Badge variant="secondary">{formatCapabilityLabel(skill.capability)}</Badge>
                    <Badge className={cn(enabledTone(skill.enabled))} variant="secondary">
                      {skill.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {targetLabel(skill, capabilities)} · {formatInvocationMode(skill.invocationMode)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={skill.enabled}
                    onCheckedChange={(enabled) => void toggleSkill(skill, enabled)}
                    disabled={busyAction === `toggle:${skill.id}`}
                    aria-label={`Enable ${skill.name}`}
                  />
                  <Button type="button" variant="ghost" size="icon" onClick={() => openEdit(skill)} aria-label={`Edit ${skill.name}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => void deleteSkill(skill)}
                    disabled={busyAction === `delete:${skill.id}`}
                    aria-label={`Delete ${skill.name}`}
                  >
                    {busyAction === `delete:${skill.id}` ? <Spinner className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                  </Button>
                </div>
              </article>
            </li>
          ))}
        </ul>
      ) : null}

      <CapabilityPicker
        open={pickerOpen}
        capabilities={capabilities}
        onOpenChange={setPickerOpen}
        onSelect={selectCapability}
      />
      <SkillForm
        open={formOpen}
        capabilities={capabilities}
        skills={skills}
        editingSkill={editingSkill}
        capabilityId={selectedCapabilityId}
        isSaving={busyAction === 'save'}
        error={busyAction === 'save' ? null : error}
        onOpenChange={(open) => {
          setFormOpen(open)
          if (!open) {
            setEditingSkill(null)
            setSelectedCapabilityId(null)
          }
        }}
        onSubmit={submitSkill}
      />
    </section>
  )
}
