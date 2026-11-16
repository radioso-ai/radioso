'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Server } from 'lucide-react'

import { ConfirmDeleteDialog, useDeleteConfirmation } from '@/components/dashboard/settings/confirm-delete-dialog'
import { QuietList, QuietListGroup, QuietListRow } from '@/components/dashboard/settings/quiet-list'
import { useScopedRowMutations } from '@/components/dashboard/settings/use-scoped-row-mutations'
import { useRegisterAddSkillAction } from '@/components/dashboard/shared/skills-header-action'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { getApiErrorMessage } from '@/lib/api-error'
import { directivesApi } from '@/lib/api-directives'
import { routinesApi } from '@/lib/api-routines'
import type { AssistantBehaviorSettings } from '@/lib/api-types'
import {
  agentSkillsApi,
  type AgentSkill,
  type AgentSkillCapabilityId,
  type AgentSkillCreateInput,
  type PlatformAnswerSkill,
  type SkillCapabilityDescriptor,
} from '@/lib/api-skills'
import { resolveAssistantRetrievalSettingsViewState } from '@/lib/assistant-retrieval-settings-view-state'
import { CapabilityPicker } from './CapabilityPicker'
import { McpServersPanel } from './McpServersPanel'
import { RecentNotifications } from './RecentNotifications'
import { isRetrievalAnswerSkill, RetrievalAnswersSwitch, type RetrievalAnswersControl } from './RetrievalAnswersSwitch'
import { SkillDetailSheet, type SkillSheetActions, type SkillSheetTarget } from './SkillDetailSheet'
import { SkillForm } from './SkillForm'
import { builtInSkillRowDomId, skillRowDomId, skillRowSummary } from './skill-list-rows'
import { countSkillUsage, describeSkillUsage, NO_SKILL_USAGE, type SkillUsage } from './skill-usage'

// The sheet holds which skill it shows, not a copy of it, so a toggle or reload shows the current
// skill and a deleted one closes the sheet. The selection belongs to one agent: switching agents
// closes it rather than carrying a built-in's sheet over to another agent.
type SheetSelection = { agentId: string } & ({ kind: 'authored'; id: string } | { kind: 'built-in'; name: string })

const resolveSheetTarget = (
  selection: SheetSelection | null,
  agentId: string,
  skills: readonly AgentSkill[],
  platformSkills: readonly PlatformAnswerSkill[],
): SkillSheetTarget | null => {
  if (!selection || selection.agentId !== agentId) return null
  if (selection.kind === 'authored') {
    const skill = skills.find((candidate) => candidate.id === selection.id)
    return skill ? { kind: 'authored', skill } : null
  }
  const skill = platformSkills.find((candidate) => candidate.name === selection.name)
  return skill ? { kind: 'built-in', skill } : null
}

// The usage sentence is left out while usage is unknown or zero: saying nothing beats a guess.
const skillDeleteDescription = (skill: AgentSkill, usage: Map<string, SkillUsage> | null): string => {
  const used = usage?.get(skill.name) ?? NO_SKILL_USAGE
  const base = `Deletes @${skill.name} from this agent.`
  return used.directives + used.routines > 0 ? `${base} ${describeSkillUsage(used)}.` : base
}

export function SkillList({
  agentId,
  assistantBehaviorSettings,
  isAssistantBehaviorLoading,
  onAssistantBehaviorDraft,
}: {
  agentId: string
  assistantBehaviorSettings: AssistantBehaviorSettings | null
  isAssistantBehaviorLoading: boolean
  onAssistantBehaviorDraft: (updater: (current: AssistantBehaviorSettings) => AssistantBehaviorSettings) => void
}) {
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [platformSkills, setPlatformSkills] = useState<PlatformAnswerSkill[]>([])
  const [capabilities, setCapabilities] = useState<SkillCapabilityDescriptor[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [serversOpen, setServersOpen] = useState(false)
  const [builtInsOpen, setBuiltInsOpen] = useState(false)
  const [sheetSelection, setSheetSelection] = useState<SheetSelection | null>(null)
  const [editingSkill, setEditingSkill] = useState<AgentSkill | null>(null)
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<AgentSkillCapabilityId | null>(null)
  // Null while the referencing surfaces are unread or unreadable: a partial count would report a
  // used skill as an orphan, which is worse than saying nothing.
  const [usage, setUsage] = useState<Map<string, SkillUsage> | null>(null)
  const loadVersion = useRef(0)
  const rowMutations = useScopedRowMutations(agentId)
  const deletion = useDeleteConfirmation<AgentSkill>()
  const retrievalSettingsViewState = resolveAssistantRetrievalSettingsViewState({
    isAssistantBehaviorLoading,
    assistantBehaviorSettings,
  })
  const retrievalAnswers: RetrievalAnswersControl = {
    enabled: retrievalSettingsViewState === 'controls',
    isOff: retrievalSettingsViewState === 'disabled',
    disabled: retrievalSettingsViewState === 'loading' || retrievalSettingsViewState === 'unavailable',
    onChange: (retrievalEnabled) => onAssistantBehaviorDraft((current) => ({ ...current, retrievalEnabled })),
  }

  // Memoized: the sheet keeps the last target it showed, compared by identity.
  const sheetTarget = useMemo(
    () => resolveSheetTarget(sheetSelection, agentId, skills, platformSkills),
    [sheetSelection, agentId, skills, platformSkills],
  )

  const loadUsage = useCallback(async (version: number) => {
    const [directiveResult, routineResult] = await Promise.allSettled([
      directivesApi.listDirectives(agentId),
      routinesApi.listRoutines(agentId),
    ])
    if (version !== loadVersion.current) return
    if (directiveResult.status !== 'fulfilled' || routineResult.status !== 'fulfilled') {
      setUsage(null)
      return
    }
    setUsage(countSkillUsage(directiveResult.value.directives, routineResult.value.routines))
  }, [agentId])

  const load = useCallback(async () => {
    const version = ++loadVersion.current
    setIsLoading(true)
    setError(null)
    void loadUsage(version)
    try {
      const [capabilityResponse, skillResponse] = await Promise.all([
        agentSkillsApi.getSkillCapabilities(agentId),
        agentSkillsApi.listSkills(agentId),
      ])
      if (version !== loadVersion.current) return
      setCapabilities(capabilityResponse.capabilities)
      setSkills(skillResponse.skills)
      setPlatformSkills(skillResponse.platformSkills)
    } catch (loadError) {
      if (version !== loadVersion.current) return
      setError(getApiErrorMessage(loadError, 'Failed to load skills.'))
    } finally {
      if (version === loadVersion.current) {
        setIsLoading(false)
      }
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

  const submitSkill = async (input: AgentSkillCreateInput) => {
    setIsSaving(true)
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
      setIsSaving(false)
    }
  }

  // Each row holds its own controls until its own request settles, so acting on a second skill
  // never releases the first one's while its update is still in flight.
  const toggleSkill = async (skill: AgentSkill, enabled: boolean) => {
    setError(null)
    const outcome = await rowMutations.run(skill.id, () => agentSkillsApi.updateSkill(agentId, skill.id, { enabled }))
    if (outcome.status === 'applied') {
      setSkills((current) => current.map((item) => item.id === skill.id ? outcome.value.skill : item))
    } else if (outcome.status === 'failed') {
      setError(getApiErrorMessage(outcome.error, 'Failed to update skill.'))
    }
  }

  const deleteSkill = async (skill: AgentSkill) => {
    setError(null)
    const outcome = await rowMutations.run(skill.id, () => agentSkillsApi.deleteSkill(agentId, skill.id))
    if (outcome.status === 'applied') {
      setSkills((current) => current.filter((item) => item.id !== skill.id))
      setSheetSelection(null)
    } else if (outcome.status === 'failed') {
      setError(getApiErrorMessage(outcome.error, 'Failed to delete skill.'))
    }
  }

  // The dialog stays open while the request runs and closes when it settles either way, so a
  // failure's message shows in the sheet underneath.
  const confirmDeleteSkill = async () => {
    if (!deletion.item) return
    await deleteSkill(deletion.item)
    deletion.dismiss()
  }

  const sheetActions: SkillSheetActions = {
    isRowPending: rowMutations.isPending,
    onToggleEnabled: (skill, enabled) => void toggleSkill(skill, enabled),
    onEdit: (skill) => {
      setError(null)
      setSheetSelection(null)
      setEditingSkill(skill)
      setSelectedCapabilityId(null)
      setFormOpen(true)
    },
    onDelete: deletion.ask,
  }

  return (
    <section id="assistant-skills-list" className="space-y-4 scroll-mt-24">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Skill changes apply live, outside Review &amp; Publish.
        </p>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setServersOpen(true)}>
          <Server className="h-4 w-4" />
          Manage MCP connections
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          Loading skills...
        </div>
      ) : null}
      {/* A reload after a save keeps the rows on screen under the spinner instead of emptying them. */}
      {skills.length > 0 ? (
        <QuietList>
          {skills.map((skill) => (
            <QuietListRow
              key={skill.id}
              domId={skillRowDomId(skill.id)}
              title={`@${skill.name}`}
              summary={skillRowSummary(skill, capabilities, usage)}
              isDimmed={!skill.enabled}
              onOpen={() => setSheetSelection({ agentId, kind: 'authored', id: skill.id })}
              lead={(
                <Switch
                  checked={skill.enabled}
                  onCheckedChange={(enabled) => void toggleSkill(skill, enabled)}
                  disabled={rowMutations.isPending(skill.id)}
                  aria-label={`Enable ${skill.name}`}
                />
              )}
            />
          ))}
        </QuietList>
      ) : !isLoading ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          This agent always answers directly, from documents, or with a clarification. Add a named skill to extend it.
        </p>
      ) : null}

      {platformSkills.length > 0 ? (
        // Retrieval answers being off changes how the agent answers, so the closed group says so.
        <QuietListGroup
          label={`Built-in skills · ${platformSkills.length}${retrievalAnswers.isOff ? ' · retrieval answers off' : ''}`}
          isOpen={builtInsOpen}
          onOpenChange={setBuiltInsOpen}
        >
          {platformSkills.map((skill) => (
            <QuietListRow
              key={skill.name}
              domId={builtInSkillRowDomId(skill.name)}
              title={skill.displayName}
              summary={skill.description}
              isDimmed={isRetrievalAnswerSkill(skill) && retrievalAnswers.isOff}
              onOpen={() => setSheetSelection({ agentId, kind: 'built-in', name: skill.name })}
              lead={isRetrievalAnswerSkill(skill) ? <RetrievalAnswersSwitch control={retrievalAnswers} /> : null}
            />
          ))}
        </QuietListGroup>
      ) : null}

      {!isLoading ? <RecentNotifications agentId={agentId} /> : null}

      <SkillDetailSheet
        target={sheetTarget}
        capabilities={capabilities}
        usage={usage}
        error={error}
        retrievalAnswers={retrievalAnswers}
        actions={sheetActions}
        onClose={() => setSheetSelection(null)}
      />
      {deletion.item ? (
        <ConfirmDeleteDialog
          open={deletion.isOpen}
          onOpenChange={(open) => { if (!open) deletion.dismiss() }}
          title="Delete skill?"
          description={skillDeleteDescription(deletion.item, usage)}
          confirmLabel="Delete skill"
          busy={rowMutations.isPending(deletion.item.id)}
          onConfirm={() => void confirmDeleteSkill()}
        />
      ) : null}
      <CapabilityPicker
        open={pickerOpen}
        agentId={agentId}
        capabilities={capabilities}
        onOpenChange={setPickerOpen}
        onSelect={selectCapability}
        onConnectionsChanged={() => void load()}
      />
      <McpServersPanel
        agentId={agentId}
        open={serversOpen}
        onOpenChange={(open) => {
          setServersOpen(open)
          if (!open) void load()
        }}
      />
      <SkillForm
        agentId={agentId}
        open={formOpen}
        capabilities={capabilities}
        skills={skills}
        editingSkill={editingSkill}
        capabilityId={selectedCapabilityId}
        isSaving={isSaving}
        error={isSaving ? null : error}
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
