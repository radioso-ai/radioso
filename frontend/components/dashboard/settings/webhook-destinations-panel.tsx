'use client'

import { useEffect, useMemo, useState } from 'react'
import { KeyRound, Pencil, Plus, RefreshCw, Trash2, Webhook } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
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

const formatDeliveryStatus = (destination: WebhookDestination): string => {
  if (!destination.lastDeliveryStatus || !destination.lastDeliveryAt) {
    return 'No deliveries yet'
  }
  const status = destination.lastDeliveryStatus.replace(/_/gu, ' ')
  return `${status} at ${new Date(destination.lastDeliveryAt).toLocaleString()}`
}

export function WebhookDestinationsPanel({
  onSaveStateChange,
}: {
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  const [destinations, setDestinations] = useState<WebhookDestination[]>([])
  const [form, setForm] = useState<DestinationForm | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { beginSave, isCurrentSave, markError, markSaved } = useSettingsSaveStatus(onSaveStateChange)

  const sortedDestinations = useMemo(
    () => [...destinations].sort((left, right) => left.name.localeCompare(right.name)),
    [destinations],
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

  const openCreate = () => {
    setSecret(null)
    setError(null)
    setForm(emptyForm())
  }

  const openEdit = (destination: WebhookDestination) => {
    setSecret(null)
    setError(null)
    setForm({
      id: destination.id,
      name: destination.name,
      url: destination.url,
    })
  }

  const saveForm = async () => {
    if (!form) return
    const name = form.name.trim()
    const url = form.url.trim()
    if (!name || !url) {
      setError('Name and URL are required.')
      return
    }

    const saveId = beginSave()
    setBusyId(form.id ?? 'create')
    setError(null)
    try {
      if (form.id) {
        const response = await webhookDestinationsApi.updateDestination(form.id, { name, url })
        if (!isCurrentSave(saveId)) return
        upsertDestination(response.destination)
        setForm(null)
        markSaved()
        return
      }
      const response = await webhookDestinationsApi.createDestination({ name, url })
      if (!isCurrentSave(saveId)) return
      upsertDestination(response.destination)
      setSecret(response.secret)
      setForm(null)
      markSaved()
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(saveError, 'Failed to save webhook destination.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) setBusyId(null)
    }
  }

  const rotateSecret = async (destination: WebhookDestination) => {
    const saveId = beginSave()
    setBusyId(`rotate:${destination.id}`)
    setError(null)
    try {
      const response = await webhookDestinationsApi.rotateSecret(destination.id)
      if (!isCurrentSave(saveId)) return
      upsertDestination(response.destination)
      setSecret(response.secret)
      markSaved()
    } catch (rotateError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(rotateError, 'Failed to rotate webhook destination secret.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) setBusyId(null)
    }
  }

  const deleteDestination = async (destination: WebhookDestination) => {
    const saveId = beginSave()
    setBusyId(`delete:${destination.id}`)
    setError(null)
    try {
      await webhookDestinationsApi.deleteDestination(destination.id)
      if (!isCurrentSave(saveId)) return
      setDestinations((current) => current.filter((item) => item.id !== destination.id))
      if (form?.id === destination.id) {
        setForm(null)
      }
      markSaved()
    } catch (deleteError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(deleteError, 'Failed to delete webhook destination.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) setBusyId(null)
    }
  }

  const isBusy = Boolean(busyId)

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
        {secret ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <CopyValueField
              label="Signing secret"
              value={secret}
              ariaLabel="Copy webhook signing secret"
              wrap
            />
          </div>
        ) : null}

        {form ? (
          <div className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto] md:items-end">
            <div className="space-y-1">
              <Label htmlFor="webhookDestinationName">Destination name</Label>
              <Input
                id="webhookDestinationName"
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
              <Button type="button" variant="ghost" onClick={() => setForm(null)} disabled={isBusy}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void saveForm()} disabled={isBusy}>
                {busyId === (form.id ?? 'create') ? <Spinner className="mr-2" /> : null}
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
          <ul className="space-y-3">
            {sortedDestinations.map((destination) => (
              <li key={destination.id} className="flex flex-col gap-3 rounded-lg border border-border p-4 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{destination.name}</p>
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {formatDeliveryStatus(destination)}
                    </span>
                  </div>
                  <p className="break-all text-sm text-muted-foreground">{destination.url}</p>
                  <p className="font-mono text-xs text-muted-foreground">{destination.id}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1">
                  <Button type="button" variant="ghost" size="sm" onClick={() => openEdit(destination)} aria-label={`Edit ${destination.name}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void rotateSecret(destination)}
                    aria-label={`Rotate secret for ${destination.name}`}
                    disabled={busyId === `rotate:${destination.id}`}
                  >
                    {busyId === `rotate:${destination.id}` ? <Spinner className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void deleteDestination(destination)}
                    aria-label={`Delete ${destination.name}`}
                    disabled={busyId === `delete:${destination.id}`}
                  >
                    {busyId === `delete:${destination.id}` ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsCard>
  )
}
