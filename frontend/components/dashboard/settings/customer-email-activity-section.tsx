'use client'

import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Clock, RefreshCw } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  customerEmailApi,
  type CustomerEmailActivity,
  type CustomerEmailSkillOutcome,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

const outcomeLabel = (outcome: CustomerEmailSkillOutcome) => {
  if (outcome === 'drafted') return 'Drafted'
  if (outcome === 'sent') return 'Sent'
  if (outcome === 'missing_input') return 'Missing input'
  if (outcome === 'disabled_connection') return 'Disabled connection'
  if (outcome === 'needs_reauth') return 'Needs re-auth'
  if (outcome === 'provider_rejected') return 'Provider rejected'
  return 'Failed'
}

const outcomeTone = (outcome: CustomerEmailSkillOutcome) => {
  if (outcome === 'drafted' || outcome === 'sent') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (outcome === 'needs_reauth' || outcome === 'provider_rejected' || outcome === 'failed') return 'bg-destructive/10 text-destructive'
  return 'bg-muted text-muted-foreground'
}

const formatTimestamp = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

const ActivityIcon = ({ outcome }: { outcome: CustomerEmailSkillOutcome }) => {
  if (outcome === 'drafted' || outcome === 'sent') return <CheckCircle2 className="h-4 w-4" />
  if (outcome === 'missing_input' || outcome === 'disabled_connection') return <Clock className="h-4 w-4" />
  return <AlertTriangle className="h-4 w-4" />
}

export function CustomerEmailActivitySection({ workspaceId }: { workspaceId: string | null }) {
  const [activities, setActivities] = useState<CustomerEmailActivity[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadActivity = async () => {
    if (!workspaceId) {
      setActivities([])
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const result = await customerEmailApi.listEmailActivity(workspaceId, { limit: 10 })
      setActivities(result.activities)
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Failed to load email skill activity.'))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void loadActivity()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workspace changes reload server-owned activity.
  }, [workspaceId])

  return (
    <SettingsCard
      id="customer-email-activity"
      icon={<Activity className="h-5 w-5 text-primary" />}
      title="Email skill activity"
      description="Inspect sanitized customer email skill outcomes and reauthorization needs."
      headerEnd={
        <Button type="button" variant="outline" size="sm" onClick={() => void loadActivity()} disabled={isLoading || !workspaceId}>
          {isLoading ? <Spinner className="size-4" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      }
    >
      <div className="space-y-4">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {isLoading && activities.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading activity
          </div>
        ) : null}
        {!isLoading && activities.length === 0 ? (
          <p className="text-sm text-muted-foreground">No email skill activity yet.</p>
        ) : null}
        {activities.length > 0 ? (
          <div className="divide-y divide-border">
            {activities.map((item) => (
              <div key={item.id} className="flex flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium text-foreground">{item.skillName}</span>
                    <Badge className={outcomeTone(item.outcome)} variant="secondary">
                      <ActivityIcon outcome={item.outcome} />
                      {outcomeLabel(item.outcome)}
                    </Badge>
                    <Badge variant="outline">{item.mode}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {item.recipientSummary.toCount} to, {item.recipientSummary.ccCount} cc
                    {item.recipientSummary.domains.length > 0 ? ` · ${item.recipientSummary.domains.join(', ')}` : ''}
                  </p>
                  {item.recipientSummary.redactedRecipients.length > 0 ? (
                    <p className="break-words font-mono text-xs text-muted-foreground">
                      {item.recipientSummary.redactedRecipients.join(', ')}
                    </p>
                  ) : null}
                  {item.errorCode ? <p className="font-mono text-xs text-muted-foreground">{item.errorCode}</p> : null}
                </div>
                <div className="shrink-0 text-sm text-muted-foreground">{formatTimestamp(item.createdAt)}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </SettingsCard>
  )
}
