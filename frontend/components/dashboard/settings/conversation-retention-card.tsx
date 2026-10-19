'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { History } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { apiAccessApi } from '@/lib/api-api-access'
import { getApiErrorMessage } from '@/lib/api-error'
import { settingsApi } from '@/lib/api-settings'
import {
  CONVERSATION_RETENTION_DAYS_MAX,
  CONVERSATION_RETENTION_DAYS_MIN,
  conversationRetentionPresets,
  parseCustomRetentionDays,
  retentionChoiceFor,
  retentionErasesSooner,
} from '@/lib/conversation-retention'
import { useWorkspace } from '@/lib/workspace-context'

/**
 * The workspace's conversation retention window. Changing it takes `workspace.history.delete`,
 * which owners and admins hold by the effective role the server resolves for the workspace; others
 * see the window without the control. A save that lets the sweep erase conversations sooner asks
 * first, because what the sweep erases cannot be restored.
 */
export function ConversationRetentionCard({ id }: { id?: string }) {
  const queryClient = useQueryClient()
  const { activeWorkspaceId } = useWorkspace()
  const queryKey = ['privacy-settings', activeWorkspaceId]
  const privacy = useQuery({
    queryKey,
    queryFn: () => settingsApi.getPrivacySettings(),
    enabled: Boolean(activeWorkspaceId),
  })
  const workspaceAccess = useQuery({
    queryKey: ['workspace-effective-role', activeWorkspaceId],
    queryFn: () => apiAccessApi.getSummary(activeWorkspaceId ?? ''),
    enabled: Boolean(activeWorkspaceId),
    staleTime: 60_000,
  })
  const stored = privacy.data?.conversationRetentionDays ?? null
  // The operator's unsaved edit; null shows the stored window.
  const [edit, setEdit] = useState<{ choice: string; customDays: string } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choice = edit?.choice ?? retentionChoiceFor(stored)
  const customDays = edit?.customDays ?? (stored === null ? '' : String(stored))

  const effectiveRole = workspaceAccess.data?.effectiveRole
  const canChange = effectiveRole === 'owner' || effectiveRole === 'admin'
  const draft = choice === 'custom'
    ? parseCustomRetentionDays(customDays)
    : conversationRetentionPresets.find((preset) => preset.value === choice)?.days ?? null
  const customInvalid = choice === 'custom' && draft === null
  const changed = !customInvalid && draft !== stored

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const saved = await settingsApi.updatePrivacySettings({ conversationRetentionDays: draft })
      queryClient.setQueryData(queryKey, saved)
      setEdit(null)
      setConfirmOpen(false)
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'The retention window could not be saved.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      id={id}
      icon={<History className="h-5 w-5 text-primary" />}
      title="Conversation retention"
      description="Erase conversations after a stretch with no activity."
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="conversationRetention">Keep conversations</Label>
            <Select
              value={choice}
              onValueChange={(value) => {
                setEdit({ choice: value, customDays })
                setError(null)
              }}
              disabled={!canChange || privacy.isLoading}
            >
              <SelectTrigger id="conversationRetention" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {conversationRetentionPresets.map((preset) => (
                  <SelectItem key={preset.value} value={preset.value}>{preset.label}</SelectItem>
                ))}
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {choice === 'custom' ? (
            <div className="space-y-1.5">
              <Label htmlFor="conversationRetentionDays">Days</Label>
              <Input
                id="conversationRetentionDays"
                inputMode="numeric"
                value={customDays}
                onChange={(event) => {
                  setEdit({ choice, customDays: event.target.value })
                  setError(null)
                }}
                className="w-28"
                disabled={!canChange}
                aria-invalid={customInvalid}
              />
            </div>
          ) : null}
          {canChange ? (
            <Button
              type="button"
              size="sm"
              disabled={!changed || saving}
              onClick={() => (retentionErasesSooner(stored, draft) ? setConfirmOpen(true) : void save())}
            >
              Save
            </Button>
          ) : null}
        </div>
        {customInvalid ? (
          <p className="text-sm text-destructive">
            Enter whole days from {CONVERSATION_RETENTION_DAYS_MIN} to {CONVERSATION_RETENTION_DAYS_MAX}.
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {stored === null
            ? 'Conversations stay until someone deletes them.'
            : `Conversations with no activity for ${stored} days are erased with everything derived from them.`}
        </p>
        {!canChange && workspaceAccess.isSuccess ? (
          <p className="text-sm text-muted-foreground">Only owners and admins can change this.</p>
        ) : null}
        {error && !confirmOpen ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      </div>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (saving) return
          setConfirmOpen(next)
          if (!next) setError(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Erase conversations after {draft} days?</AlertDialogTitle>
            <AlertDialogDescription>
              Conversations with no activity for {draft} days are erased with everything derived from them, starting
              within 15 minutes. Erased conversations cannot be restored.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void save()
              }}
              disabled={saving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {saving ? 'Saving…' : `Erase after ${String(draft)} days`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}
