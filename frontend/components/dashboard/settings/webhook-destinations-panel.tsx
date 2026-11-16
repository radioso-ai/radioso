'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Webhook } from 'lucide-react'

import { QuietList, QuietListRow } from '@/components/dashboard/settings/quiet-list'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useScopedRowMutations, type RowMutationOutcome } from '@/components/dashboard/settings/use-scoped-row-mutations'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import {
  deliveryAttentionLabel,
  webhookDestinationRowDomId,
} from '@/components/dashboard/settings/webhook-destination-rows'
import {
  WebhookDestinationSheet,
  type WebhookSheetAction,
  type WebhookSheetActions,
} from '@/components/dashboard/settings/webhook-destination-sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  webhookDestinationsApi,
  type WebhookDestination,
} from '@/lib/api'

type DestinationForm = {
  id: string | null
  name: string
  url: string
}

const emptyForm = (): DestinationForm => ({
  id: null,
  name: '',
  url: '',
})

// A signing secret is shown once, next to the destination it was issued for.
type IssuedSecret = { destinationId: string; value: string }

// The panel belongs to the workspace and has no id of its own to scope row locks by.
const ROW_MUTATION_SCOPE = 'webhook-destinations'

// The create and edit form is one more row of work, locked like the rest.
const FORM_ROW = 'form'

const rowMutationKey = (action: WebhookSheetAction, destinationId: string): string => `${action}:${destinationId}`

function SigningSecretNotice({ secret }: { secret: string }) {
  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
      <CopyValueField
        label="Signing secret"
        value={secret}
        ariaLabel="Copy webhook signing secret"
        wrap
      />
    </div>
  )
}

export function WebhookDestinationsPanel({
  onSaveStateChange,
}: {
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  const [destinations, setDestinations] = useState<WebhookDestination[]>([])
  const [form, setForm] = useState<DestinationForm | null>(null)
  const [secret, setSecret] = useState<IssuedSecret | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The sheet holds which destination it shows, not a copy, so a rotated one shows its current
  // data and a deleted one closes the sheet.
  const [sheetDestinationId, setSheetDestinationId] = useState<string | null>(null)
  const { beginSave, isCurrentSave, markError, markSaved, resetSaveState } = useSettingsSaveStatus(onSaveStateChange)
  const rowMutations = useScopedRowMutations(ROW_MUTATION_SCOPE)
  // A form save and a delete are separate requests, so a save can land after its destination is
  // gone. Ids are never reused, so remembering them is enough to drop that response.
  const deletedDestinationIds = useRef(new Set<string>())
  // The form takes the keyboard when it opens, and again when it switches to another destination.
  const nameInputRef = useRef<HTMLInputElement>(null)
  const shouldFocusForm = useRef(false)

  const isSavingForm = rowMutations.isPending(FORM_ROW)

  const sortedDestinations = useMemo(
    () => [...destinations].sort((left, right) => left.name.localeCompare(right.name)),
    [destinations],
  )
  // Memoized: the sheet keeps the last target it showed, compared by identity.
  const sheetDestination = useMemo(
    () => destinations.find((destination) => destination.id === sheetDestinationId) ?? null,
    [destinations, sheetDestinationId],
  )

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setIsLoading(true)
      setError(null)
      void webhookDestinationsApi.listDestinations()
        .then((response) => {
          if (!active) return
          setDestinations(response.destinations)
        })
        .catch((loadError) => {
          if (!active) return
          setError(getApiErrorMessage(loadError, 'Failed to load webhook destinations.'))
        })
        .finally(() => {
          if (active) setIsLoading(false)
        })
    })
    return () => {
      active = false
    }
  }, [])

  const upsertDestination = (destination: WebhookDestination) => {
    setDestinations((current) => {
      const without = current.filter((item) => item.id !== destination.id)
      return [...without, destination]
    })
  }

  // Runs once the form this open rendered is on screen; typing re-renders it without moving focus.
  // Focusing the input also scrolls it into view.
  useEffect(() => {
    if (!form || !shouldFocusForm.current) return
    shouldFocusForm.current = false
    nameInputRef.current?.focus()
  }, [form])

  const openCreate = () => {
    setSecret(null)
    setError(null)
    shouldFocusForm.current = true
    setForm(emptyForm())
  }

  const openEdit = (destination: WebhookDestination) => {
    setSecret(null)
    setError(null)
    shouldFocusForm.current = true
    setForm({
      id: destination.id,
      name: destination.name,
      url: destination.url,
    })
  }

  // beginSave already told the section it is saving, so every settled mutation answers it: a
  // failure names itself, a stale one clears the announcement. Only the newest save may speak.
  const settleOutcome = <T,>(
    saveId: number,
    outcome: RowMutationOutcome<T>,
    failureMessage: string,
  ): { value: T } | null => {
    if (outcome.status === 'applied') return { value: outcome.value }
    if (outcome.status === 'stale') {
      if (isCurrentSave(saveId)) resetSaveState()
      return null
    }
    const message = getApiErrorMessage(outcome.error, failureMessage)
    setError(message)
    if (isCurrentSave(saveId)) markError(message)
    return null
  }

  const saveForm = async () => {
    if (!form) return
    const name = form.name.trim()
    const url = form.url.trim()
    if (!name || !url) {
      setError('Name and URL are required.')
      return
    }

    const editedId = form.id
    const saveId = beginSave()
    setError(null)
    const outcome = await rowMutations.run(FORM_ROW, async () => {
      if (editedId) {
        const response = await webhookDestinationsApi.updateDestination(editedId, { name, url })
        return { destination: response.destination, secret: null }
      }
      return webhookDestinationsApi.createDestination({ name, url })
    })
    const settled = settleOutcome(saveId, outcome, 'Failed to save webhook destination.')
    if (!settled) return
    // The destination was deleted while this save was in flight: its row must not come back.
    if (editedId && deletedDestinationIds.current.has(editedId)) {
      if (isCurrentSave(saveId)) resetSaveState()
      return
    }
    upsertDestination(settled.value.destination)
    if (settled.value.secret) setSecret({ destinationId: settled.value.destination.id, value: settled.value.secret })
    setForm(null)
    if (isCurrentSave(saveId)) markSaved()
  }

  // Each destination holds its own controls until its own request settles, so acting on a second
  // one never releases the first one's while it is still in flight. A committed response is always
  // applied; the section's save chip has one thing to say, so it stays last-write-wins.
  const rotateSecret = async (destination: WebhookDestination) => {
    const saveId = beginSave()
    setError(null)
    const outcome = await rowMutations.run(
      rowMutationKey('rotate', destination.id),
      () => webhookDestinationsApi.rotateSecret(destination.id),
    )
    const settled = settleOutcome(saveId, outcome, 'Failed to rotate webhook destination secret.')
    if (!settled) return
    upsertDestination(settled.value.destination)
    setSecret({ destinationId: destination.id, value: settled.value.secret })
    if (isCurrentSave(saveId)) markSaved()
  }

  const deleteDestination = async (destination: WebhookDestination) => {
    const saveId = beginSave()
    setError(null)
    const outcome = await rowMutations.run(
      rowMutationKey('delete', destination.id),
      () => webhookDestinationsApi.deleteDestination(destination.id),
    )
    if (!settleOutcome(saveId, outcome, 'Failed to delete webhook destination.')) return
    deletedDestinationIds.current.add(destination.id)
    setDestinations((current) => current.filter((item) => item.id !== destination.id))
    // The operator may have opened another destination while this one was being deleted.
    setSheetDestinationId((current) => (current === destination.id ? null : current))
    setForm((current) => (current?.id === destination.id ? null : current))
    if (isCurrentSave(saveId)) markSaved()
  }

  const sheetActions: WebhookSheetActions = {
    pendingAction: (destinationId) => {
      if (rowMutations.isPending(rowMutationKey('rotate', destinationId))) return 'rotate'
      if (rowMutations.isPending(rowMutationKey('delete', destinationId))) return 'delete'
      return null
    },
    onEdit: (destination) => {
      setSheetDestinationId(null)
      openEdit(destination)
    },
    onRotateSecret: (destination) => void rotateSecret(destination),
    onDelete: (destination) => void deleteDestination(destination),
  }

  // A secret issued for the destination whose sheet is open shows in the sheet, which covers the
  // section; otherwise it shows in the section.
  const isSecretInSheet = secret !== null && secret.destinationId === sheetDestination?.id

  return (
    <SettingsCard
      id="webhook-destinations"
      icon={<Webhook className="h-5 w-5 text-primary" />}
      title="Webhook destinations"
      description="Reusable signed HTTPS endpoints that routines can export completion data to."
      headerEnd={(
        <Button type="button" size="sm" onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          New destination
        </Button>
      )}
    >
      <div className="space-y-4">
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {secret && !isSecretInSheet ? <SigningSecretNotice secret={secret.value} /> : null}

        {form ? (
          <div className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto] md:items-end">
            <div className="space-y-1">
              <Label htmlFor="webhookDestinationName">Destination name</Label>
              <Input
                id="webhookDestinationName"
                ref={nameInputRef}
                value={form.name}
                onChange={(event) => setForm((current) => current ? { ...current, name: event.target.value } : current)}
                placeholder="crm-leads"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="webhookDestinationUrl">Destination URL</Label>
              <Input
                id="webhookDestinationUrl"
                type="url"
                value={form.url}
                onChange={(event) => setForm((current) => current ? { ...current, url: event.target.value } : current)}
                placeholder="https://example.com/hooks/leads"
              />
            </div>
            <div className="flex flex-wrap gap-2 md:justify-end">
              <Button type="button" variant="ghost" onClick={() => setForm(null)} disabled={isSavingForm}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void saveForm()} loading={isSavingForm}>
                {form.id ? 'Save destination' : 'Create destination'}
              </Button>
            </div>
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading webhook destinations...
          </div>
        ) : sortedDestinations.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No webhook destinations yet.
          </p>
        ) : (
          <QuietList>
            {sortedDestinations.map((destination) => {
              const attention = deliveryAttentionLabel(destination)
              return (
                <QuietListRow
                  key={destination.id}
                  domId={webhookDestinationRowDomId(destination.id)}
                  title={destination.name}
                  summary={destination.url}
                  badge={attention ? (
                    <Badge variant="outline" className="shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                      {attention}
                    </Badge>
                  ) : null}
                  onOpen={() => {
                    setError(null)
                    setSheetDestinationId(destination.id)
                  }}
                />
              )
            })}
          </QuietList>
        )}
      </div>

      <WebhookDestinationSheet
        destination={sheetDestination}
        error={error}
        secretNotice={secret && isSecretInSheet ? <SigningSecretNotice secret={secret.value} /> : null}
        actions={sheetActions}
        onClose={() => setSheetDestinationId(null)}
      />
    </SettingsCard>
  )
}
