'use client'

import { useEffect, useMemo, useState } from 'react'
import { MailPlus, Plus, Trash2 } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { getApiErrorMessage } from '@/lib/api-error'
import {
  customerEmailApi,
  type CustomerEmailConnection,
  type CustomerEmailSkillDefinition,
  type CustomerEmailSkillMode,
} from '@/lib/api'
import {
  buildCustomerEmailSkillDraft,
  customerEmailInputFields,
  defaultCustomerEmailSkillDraft,
  type CustomerEmailFieldMode,
  type CustomerEmailInputKey,
  type CustomerEmailSkillDraft,
} from '@/lib/customer-email-skills'

const modeLabel: Record<CustomerEmailFieldMode, string> = {
  bind: 'Fixed',
  expose: 'Collect',
  ignore: 'Skip',
}

const skillModeLabel: Record<CustomerEmailSkillMode, string> = {
  draft: 'Draft',
  send: 'Send',
}

const badgeTone = (enabled: boolean) =>
  enabled ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'

export function AssistantEmailSkillsSection({
  agentId,
  workspaceId,
}: {
  agentId: string
  workspaceId: string | null
}) {
  const [connections, setConnections] = useState<CustomerEmailConnection[]>([])
  const [skills, setSkills] = useState<CustomerEmailSkillDefinition[]>([])
  const [draft, setDraft] = useState<CustomerEmailSkillDraft>(() => defaultCustomerEmailSkillDraft())
  const [isLoading, setIsLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const usableConnections = useMemo(
    () => connections.filter((connection) => connection.status === 'authorized'),
    [connections],
  )

  const load = async () => {
    if (!workspaceId) {
      setConnections([])
      setSkills([])
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const [connectionResponse, skillResponse] = await Promise.all([
        customerEmailApi.listEmailConnections(workspaceId),
        customerEmailApi.listEmailSkills(agentId),
      ])
      setConnections(connectionResponse.connections)
      setSkills(skillResponse.skills)
      setDraft((current) => {
        if (current.connectionId) return current
        return defaultCustomerEmailSkillDraft(connectionResponse.connections.find((connection) => connection.status === 'authorized')?.id ?? '')
      })
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Failed to load email skills.'))
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

  const updateField = (
    key: CustomerEmailInputKey,
    patch: Partial<CustomerEmailSkillDraft['fields'][CustomerEmailInputKey]>,
  ) => {
    setDraft((current) => ({
      ...current,
      fields: {
        ...current.fields,
        [key]: {
          ...current.fields[key],
          ...patch,
        },
      },
    }))
  }

  const createSkill = async () => {
    const built = buildCustomerEmailSkillDraft(draft)
    if ('errors' in built) {
      setError(built.errors.join(' '))
      return
    }
    setBusyAction('create')
    setError(null)
    try {
      await customerEmailApi.createEmailSkill(agentId, built)
      setDraft(defaultCustomerEmailSkillDraft(draft.connectionId))
      await load()
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'Failed to save email skill.'))
    } finally {
      setBusyAction(null)
    }
  }

  const toggleSkill = async (skill: CustomerEmailSkillDefinition, enabled: boolean) => {
    setBusyAction(`toggle:${skill.id}`)
    setError(null)
    try {
      await customerEmailApi.updateEmailSkill(agentId, skill.id, { enabled })
      await load()
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'Failed to update email skill.'))
    } finally {
      setBusyAction(null)
    }
  }

  const deleteSkill = async (skill: CustomerEmailSkillDefinition) => {
    setBusyAction(`delete:${skill.id}`)
    setError(null)
    try {
      await customerEmailApi.deleteEmailSkill(agentId, skill.id)
      await load()
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete email skill.'))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <SettingsCard
      id="assistant-email-skills"
      icon={<MailPlus className="h-5 w-5 text-primary" />}
      title="Email skills"
      description="Define allowlisted draft or send actions over customer-owned email connections."
      headerEnd={skills.length > 0 ? (
        <Badge variant="secondary">{skills.length} configured</Badge>
      ) : null}
    >
      <div className="space-y-5">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading email skills...
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_9rem_8rem]">
          <div className="space-y-2">
            <Label>Connection</Label>
            <Select
              value={draft.connectionId}
              onValueChange={(connectionId) => setDraft((current) => ({ ...current, connectionId }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a connection" />
              </SelectTrigger>
              <SelectContent>
                {usableConnections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Mode</Label>
            <Select
              value={draft.mode}
              onValueChange={(mode) => setDraft((current) => ({ ...current, mode: mode as CustomerEmailSkillMode }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="send">Send</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Switch
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            />
          </div>
          <div className="space-y-2 md:col-span-3">
            <Label htmlFor="email-skill-name">Skill name</Label>
            <Input
              id="email-skill-name"
              value={draft.skillName}
              onChange={(event) => setDraft((current) => ({ ...current, skillName: event.target.value }))}
            />
          </div>
        </div>

        <div className="space-y-3">
          {customerEmailInputFields.map((field) => {
            const fieldDraft = draft.fields[field.key]
            return (
              <div key={field.key} className="grid gap-3 rounded-md border border-border bg-muted/20 p-3 md:grid-cols-[8rem_8rem_minmax(0,1fr)]">
                <div className="flex items-center gap-2">
                  <Label>{field.label}</Label>
                  {field.required ? <Badge variant="outline">Required</Badge> : null}
                </div>
                <Select
                  value={fieldDraft.mode}
                  onValueChange={(mode) => updateField(field.key, { mode: mode as CustomerEmailFieldMode })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="expose">{modeLabel.expose}</SelectItem>
                    <SelectItem value="bind">{modeLabel.bind}</SelectItem>
                    <SelectItem value="ignore">{modeLabel.ignore}</SelectItem>
                  </SelectContent>
                </Select>
                {fieldDraft.mode === 'bind' ? (
                  <Input
                    value={fieldDraft.value}
                    onChange={(event) => updateField(field.key, { value: event.target.value })}
                    placeholder={field.label}
                  />
                ) : fieldDraft.mode === 'expose' ? (
                  <Input
                    value={fieldDraft.slotBinding}
                    onChange={(event) => updateField(field.key, { slotBinding: event.target.value })}
                    placeholder="routineSlot"
                  />
                ) : (
                  <div />
                )}
              </div>
            )
          })}
        </div>

        <Button
          type="button"
          onClick={createSkill}
          disabled={busyAction === 'create' || !workspaceId || !draft.connectionId || usableConnections.length === 0}
        >
          {busyAction === 'create' ? <Spinner className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
          Save email skill
        </Button>

        <div className="space-y-2">
          {skills.map((skill) => (
            <div key={skill.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{skill.skillName}</p>
                <p className="text-xs text-muted-foreground">{skillModeLabel[skill.mode]} over {connections.find((connection) => connection.id === skill.connectionId)?.displayName ?? 'email connection'}</p>
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
