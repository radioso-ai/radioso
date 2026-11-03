'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getApiErrorMessage } from '@/lib/api-error'
import { settingsApi } from '@/lib/api-settings'
import {
  supportedTimeZones,
  timeZoneFromOption,
  timeZoneOptionFor,
  timeZoneOptions,
} from '@/lib/time-zone-options'
import { useWorkspace } from '@/lib/workspace-context'

/**
 * The zone the workspace reads "today" in. A visitor whose browser reports a zone reads today in
 * their own; this one covers everyone else, so "tomorrow" means the right day for them.
 */
export function TimeZoneCard({ id }: { id?: string }) {
  const queryClient = useQueryClient()
  const { activeWorkspaceId } = useWorkspace()
  const queryKey = ['time-zone-settings', activeWorkspaceId]
  const settings = useQuery({
    queryKey,
    queryFn: () => settingsApi.getTimeZoneSettings(),
    enabled: Boolean(activeWorkspaceId),
  })
  const stored = settings.data?.timeZone ?? null
  // The operator's unsaved choice; null shows the stored zone.
  const [edit, setEdit] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choice = edit ?? timeZoneOptionFor(stored)
  const options = useMemo(() => timeZoneOptions(supportedTimeZones(), stored), [stored])
  const changed = timeZoneFromOption(choice) !== stored

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const saved = await settingsApi.updateTimeZoneSettings({ timeZone: timeZoneFromOption(choice) })
      queryClient.setQueryData(queryKey, saved)
      setEdit(null)
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'The time zone could not be saved.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      id={id}
      icon={<Clock className="h-5 w-5 text-primary" />}
      title="Time zone"
      description="The day “today”, “tomorrow” and “this weekend” mean in answers."
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="workspaceTimeZone">Time zone</Label>
            <Select
              value={choice}
              onValueChange={(value) => {
                setEdit(value)
                setError(null)
              }}
              disabled={settings.isLoading}
            >
              <SelectTrigger id="workspaceTimeZone" className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" size="sm" aria-label="Save time zone" disabled={!changed || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Visitors whose browser reports a time zone get their own today. This zone covers everyone else: email, Slack
          and voice conversations, and API calls that name no zone.
        </p>
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      </div>
    </SettingsCard>
  )
}
