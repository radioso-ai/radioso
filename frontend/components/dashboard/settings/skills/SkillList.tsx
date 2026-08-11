'use client'

import { useCallback, useEffect, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'

import { useRegisterAddSkillAction } from '@/components/dashboard/shared/skills-header-action'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { getApiErrorMessage } from '@/lib/api-error'
import { directivesApi } from '@/lib/api-directives'
import { routinesApi } from '@/lib/api-routines'
import { agentSkillsApi, type AgentSkill, type AgentSkillCapabilityId, type AgentSkillCreateInput, type SkillCapabilityDescriptor } from '@/lib/api-skills'
import { cn } from '@/lib/utils'
import { CapabilityPicker } from './CapabilityPicker'
import { SkillForm } from './SkillForm'
import { formatCapabilityLabel, formatInvocationMode } from './skill-form-model'
import { countSkillUsage, describeSkillUsage, NO_SKILL_USAGE, type SkillUsage } from './skill-usage'

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
  // Null while the referencing surfaces are unread or unreadable: a partial count would report a
  // used skill as an orphan, which is worse than saying nothing.
  const [usage, setUsage] = useState<Map<string, SkillUsage> | null>(null)

  const loadUsage = useCallback(async () => {
    const [directiveResult, routineResult] = await Promise.allSettled([
      directivesApi.listDirectives(agentId),
      routinesApi.listRoutines(agentId),
    ])
    if (directiveResult.status !== 'fulfilled' || routineResult.status !== 'fulfilled') {
      setUsage(null)
      return
    }
    setUsage(countSkillUsage(directiveResult.value.directives, routineResult.value.routines))
  }, [agentId])

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    void loadUsage()
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
  }, [agentId, loadUsage])

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
          replaceConfig: input.config,
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
                    {usage ? ` · ${describeSkillUsage(usage.get(skill.name) ?? NO_SKILL_USAGE)}` : ''}
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
        agentId={agentId}
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
