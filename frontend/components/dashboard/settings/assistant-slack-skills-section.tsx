'use client'

import { useEffect, useState } from 'react'
import { MessageSquarePlus, Plus, Trash2 } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { getApiErrorMessage } from '@/lib/api-error'
import { slackApi, type SlackInstallStatusResponse } from '@/lib/api-slack'
import { slackSkillsApi, type SlackSkillDefinition } from '@/lib/api-slack-skills'

type SlackSkillDraft = {
  skillName: string
  channel: string
  channelSlotBinding: string
  messageSlotBinding: string
  enabled: boolean
}

const defaultDraft = (): SlackSkillDraft => ({
  skillName: 'post_to_slack',
  channel: '',
  channelSlotBinding: 'channel',
  messageSlotBinding: 'message',
  enabled: true,
})

const badgeTone = (enabled: boolean) =>
  enabled ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'

export function AssistantSlackSkillsSection({
  agentId,
  workspaceId,
}: {
  agentId: string
  workspaceId: string | null
}) {
  const [status, setStatus] = useState<SlackInstallStatusResponse | null>(null)
  const [skills, setSkills] = useState<SlackSkillDefinition[]>([])
  const [draft, setDraft] = useState<SlackSkillDraft>(() => defaultDraft())
  const [isLoading, setIsLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    if (!workspaceId) {
      setStatus(null)
      setSkills([])
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const [nextStatus, skillResponse] = await Promise.all([
        slackApi.getInstallStatus(workspaceId, agentId),
        slackSkillsApi.list(agentId),
      ])
      setStatus(nextStatus)
      setSkills(skillResponse.skills)
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Failed to load Slack skills.'))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void load()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reload when agent/workspace changes.
  }, [agentId, workspaceId])

  const createSkill = async () => {
    const installationId = status?.installationId
    const skillName = draft.skillName.trim()
    const messageSlotBinding = draft.messageSlotBinding.trim()
    const channel = draft.channel.trim()
    const channelSlotBinding = draft.channelSlotBinding.trim()
    if (!installationId) {
      setError('Connect Slack before saving a Slack skill.')
      return
    }
    if (!skillName || !messageSlotBinding || (!channel && !channelSlotBinding)) {
      setError('Provide a skill name, message slot, and either a fixed channel or channel slot.')
      return
    }
    setBusyAction('create')
    setError(null)
    try {
      await slackSkillsApi.create(agentId, {
        skillName,
        installationId,
        boundInputs: channel ? { channelId: channel } : {},
        exposedInputs: {
          ...(!channel ? { channelId: { slotBinding: channelSlotBinding, required: true } } : {}),
          text: { slotBinding: messageSlotBinding, required: true },
        },
        enabled: draft.enabled,
      })
      setDraft(defaultDraft())
      await load()
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'Failed to save Slack skill.'))
    } finally {
      setBusyAction(null)
    }
  }

  const toggleSkill = async (skill: SlackSkillDefinition, enabled: boolean) => {
    setBusyAction(`toggle:${skill.id}`)
    setError(null)
    try {
      await slackSkillsApi.update(agentId, skill.id, { enabled })
      await load()
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'Failed to update Slack skill.'))
    } finally {
      setBusyAction(null)
    }
  }

  const deleteSkill = async (skill: SlackSkillDefinition) => {
    setBusyAction(`delete:${skill.id}`)
    setError(null)
    try {
      await slackSkillsApi.delete(agentId, skill.id)
      await load()
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete Slack skill.'))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <SettingsCard
      id="assistant-slack-skills"
      icon={<MessageSquarePlus className="h-5 w-5 text-primary" />}
      title="Slack skills"
      description="Define allowlisted Slack post actions for routines."
      headerEnd={skills.length > 0 ? (
        <Badge variant="secondary">{skills.length} configured</Badge>
      ) : null}
    >
      <div className="space-y-5">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading Slack skills...
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem]">
          <div className="space-y-2">
            <Label htmlFor="slack-skill-name">Skill name</Label>
            <Input
              id="slack-skill-name"
              value={draft.skillName}
              onChange={(event) => setDraft((current) => ({ ...current, skillName: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="slack-skill-channel">Fixed channel</Label>
            <Input
              id="slack-skill-channel"
              value={draft.channel}
              onChange={(event) => setDraft((current) => ({ ...current, channel: event.target.value }))}
              placeholder="C1234567890 or #team"
            />
          </div>
          <div className="flex items-end gap-2">
            <Switch
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="slack-skill-channel-slot">Channel slot</Label>
            <Input
              id="slack-skill-channel-slot"
              value={draft.channelSlotBinding}
              onChange={(event) => setDraft((current) => ({ ...current, channelSlotBinding: event.target.value }))}
              disabled={Boolean(draft.channel.trim())}
              placeholder="channel"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="slack-skill-message-slot">Message slot</Label>
            <Input
              id="slack-skill-message-slot"
              value={draft.messageSlotBinding}
              onChange={(event) => setDraft((current) => ({ ...current, messageSlotBinding: event.target.value }))}
              placeholder="message"
            />
          </div>
        </div>

        <Button
          type="button"
          onClick={createSkill}
          disabled={busyAction === 'create' || !workspaceId || status?.status !== 'connected'}
        >
          {busyAction === 'create' ? <Spinner className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
          Save Slack skill
        </Button>

        <div className="space-y-2">
          {skills.map((skill) => (
            <div key={skill.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{skill.skillName}</p>
                <p className="text-xs text-muted-foreground">
                  {typeof skill.boundInputs.channelId === 'string'
                    ? `Posts to ${skill.boundInputs.channelId}`
                    : `Collects ${skill.exposedInputs.channelId?.slotBinding ?? 'channel'} and ${skill.exposedInputs.text?.slotBinding ?? 'message'}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge className={badgeTone(skill.enabled)} variant="secondary">
                  {skill.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                <Switch
                  checked={skill.enabled}
                  onCheckedChange={(enabled) => void toggleSkill(skill, enabled)}
                  disabled={busyAction === `toggle:${skill.id}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => void deleteSkill(skill)}
                  disabled={busyAction === `delete:${skill.id}`}
                  aria-label={`Delete ${skill.skillName}`}
                >
                  {busyAction === `delete:${skill.id}` ? <Spinner className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </SettingsCard>
  )
}
