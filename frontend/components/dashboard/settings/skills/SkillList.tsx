'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, RefreshCw, Trash2, Wrench } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { getApiErrorMessage } from '@/lib/api-error'
import { agentSkillsApi, type AgentSkill, type AgentSkillCreateInput, type SkillCapabilityDescriptor } from '@/lib/api-skills'
import { cn } from '@/lib/utils'
import { SkillForm } from './SkillForm'
import { formatCapabilityLabel, formatInvocationMode } from './skill-form-model'

const targetLabel = (skill: AgentSkill, capabilities: readonly SkillCapabilityDescriptor[]) => {
  const capability = capabilities.find((candidate) => candidate.id === skill.capability)
  const target = capability?.targets.find((candidate) => candidate.id === skill.target.id)
  return target?.label ?? skill.target.id ?? skill.target.kind
}

const enabledTone = (enabled: boolean) =>
  enabled ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'

export function SkillList({ agentId }: { agentId: string }) {
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [capabilities, setCapabilities] = useState<SkillCapabilityDescriptor[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editingSkill, setEditingSkill] = useState<AgentSkill | null>(null)
  const availableCapabilityCount = useMemo(
    () => capabilities.filter((capability) => capability.available).length,
    [capabilities],
  )

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

  const openCreate = () => {
    setEditingSkill(null)
    setFormOpen(true)
  }

  const openEdit = (skill: AgentSkill) => {
    setEditingSkill(skill)
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
    <SettingsCard
      id="assistant-skills-list"
      icon={<Wrench className="h-5 w-5 text-primary" />}
      title="Skills"
      description="Named capabilities this agent can use from routines or supported invocation modes."
      headerEnd={(
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={isLoading}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button type="button" size="sm" onClick={openCreate} disabled={isLoading || availableCapabilityCount === 0}>
            <Plus className="h-4 w-4" />
            Add new skill
          </Button>
        </div>
      )}
    >
      <div className="space-y-5">
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading skills...
          </div>
        ) : null}

        {!isLoading && capabilities.some((capability) => !capability.available) ? (
          <div className="flex flex-wrap gap-2">
            {capabilities.filter((capability) => !capability.available).map((capability) => (
              <Badge key={capability.id} variant="outline" className="text-muted-foreground">
                {formatCapabilityLabel(capability.id)} needs connection
              </Badge>
            ))}
          </div>
        ) : null}

        {!isLoading && skills.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
            No skills yet. Add a named skill after connecting at least one target.
          </div>
        ) : null}

        {skills.length > 0 ? (
          <div className="divide-y divide-border rounded-md border border-border">
            {skills.map((skill) => (
              <div key={skill.id} className="flex flex-col gap-3 p-3 md:flex-row md:items-center md:justify-between">
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
              </div>
            ))}
          </div>
        ) : null}

        <SkillForm
          open={formOpen}
          capabilities={capabilities}
          skills={skills}
          editingSkill={editingSkill}
          isSaving={busyAction === 'save'}
          error={busyAction === 'save' ? null : error}
          onOpenChange={(open) => {
            setFormOpen(open)
            if (!open) {
              setEditingSkill(null)
            }
          }}
          onSubmit={submitSkill}
        />
      </div>
    </SettingsCard>
  )
}
