'use client'

import { useId, useState } from 'react'

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
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useDashboardQueryInvalidation } from '@/components/providers/dashboard-query-provider'
import { documentsApi, type DocumentSourceListItem, type DocumentSourceRecrawlCadence } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

const pageCount = (count: number) => `${count} ${count === 1 ? 'page' : 'pages'}`

const formatNextCheck = (value: string | null | undefined) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

type ActiveCadence = Exclude<DocumentSourceRecrawlCadence, 'off'>
const CADENCE_SPEED: Record<ActiveCadence, number> = { monthly: 1, weekly: 2, daily: 3 }
const CADENCE_LABEL: Record<ActiveCadence, string> = { monthly: 'Monthly', weekly: 'Weekly', daily: 'Daily' }

/** What the plan's ceiling means for this source: which options it lacks, and what a faster stored choice runs at. */
function recrawlPlanHint(cadence: DocumentSourceRecrawlCadence, fastest: ActiveCadence): string | null {
  if (fastest === 'daily') return null
  if (cadence !== 'off' && CADENCE_SPEED[cadence] > CADENCE_SPEED[fastest]) {
    return `${CADENCE_LABEL[cadence]} isn’t on your plan, so it checks ${fastest}.`
  }
  return fastest === 'monthly' ? 'Weekly and daily aren’t on your plan.' : 'Daily isn’t on your plan.'
}

/**
 * A website source's "Keep up to date" cadence, when it next checks, and the pages a crawl
 * held because too many went missing at once.
 */
export function SourceRecrawlControls({
  source,
  onSourceUpdated,
}: {
  source: DocumentSourceListItem
  onSourceUpdated: (source: DocumentSourceListItem) => void
}) {
  const fieldId = useId()
  const invalidateDashboardQueries = useDashboardQueryInvalidation()
  const [pendingAction, setPendingAction] = useState<'cadence' | 'remove' | 'keep' | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cadence = source.recrawlCadence ?? 'off'
  const fastest = source.fastestRecrawlCadence ?? 'daily'
  const onPlan = (option: DocumentSourceRecrawlCadence) =>
    option === 'off' || CADENCE_SPEED[option] <= CADENCE_SPEED[fastest]
  const planHint = recrawlPlanHint(cadence, fastest)
  const heldPageCount = source.heldPageCount ?? 0
  const nextCheck = cadence === 'off' ? null : formatNextCheck(source.nextRecrawlAt)

  const handleCadenceChange = async (next: DocumentSourceRecrawlCadence) => {
    setPendingAction('cadence')
    setError(null)
    try {
      const updated = await documentsApi.setSourceRecrawlCadence(source.id, next)
      onSourceUpdated({
        ...source,
        recrawlCadence: updated.recrawlCadence,
        nextRecrawlAt: updated.nextRecrawlAt,
        fastestRecrawlCadence: updated.fastestRecrawlCadence,
      })
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to save how often this site is checked.'))
    } finally {
      setPendingAction(null)
    }
  }

  const handleHeldPages = async (decision: 'remove' | 'keep') => {
    setPendingAction(decision)
    setError(null)
    try {
      if (decision === 'remove') {
        await documentsApi.removeSourceHeldPages(source.id)
        onSourceUpdated({ ...source, heldPageCount: 0 })
        // The source and the workspace lose documents.
        invalidateDashboardQueries(['document.status_changed'])
      } else {
        await documentsApi.keepSourceHeldPages(source.id)
        onSourceUpdated({ ...source, heldPageCount: 0 })
      }
    } catch (err) {
      setError(getApiErrorMessage(err, decision === 'remove' ? 'Failed to remove pages.' : 'Failed to keep pages.'))
    } finally {
      setPendingAction(null)
      setConfirmingRemove(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Label htmlFor={fieldId} className="text-xs font-normal text-muted-foreground">Keep up to date</Label>
        <Select
          value={cadence}
          disabled={pendingAction !== null}
          onValueChange={(next) => void handleCadenceChange(next as DocumentSourceRecrawlCadence)}
        >
          <SelectTrigger id={fieldId} className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
            <SelectItem value="weekly" disabled={!onPlan('weekly')}>Weekly</SelectItem>
            <SelectItem value="daily" disabled={!onPlan('daily')}>Daily</SelectItem>
          </SelectContent>
        </Select>
        {pendingAction === 'cadence' ? <Spinner className="h-3.5 w-3.5" /> : null}
        {nextCheck ? <span className="text-xs text-muted-foreground">Next check {nextCheck}</span> : null}
        {planHint ? <span className="text-xs text-muted-foreground">{planHint}</span> : null}
      </div>
      {heldPageCount > 0 ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-xs">
          <span className="text-foreground">
            {pageCount(heldPageCount)} {heldPageCount === 1 ? 'is' : 'are'} no longer on the site
          </span>
          <Button type="button" variant="outline" size="sm" disabled={pendingAction !== null} onClick={() => setConfirmingRemove(true)}>
            Remove
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={pendingAction !== null} onClick={() => void handleHeldPages('keep')}>
            {pendingAction === 'keep' ? <Spinner className="mr-2 h-3.5 w-3.5" /> : null}
            Keep
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
      <AlertDialog open={confirmingRemove} onOpenChange={(open) => { if (!open) setConfirmingRemove(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pageCount(heldPageCount)}?</AlertDialogTitle>
            <AlertDialogDescription>
              They’re deleted from this source. A later check adds any that come back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingAction === 'remove'}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pendingAction === 'remove'}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                void handleHeldPages('remove')
              }}
            >
              {pendingAction === 'remove' ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
