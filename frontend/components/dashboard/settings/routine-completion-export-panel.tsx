'use client'

import { Webhook } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { RoutineCompletionExport, RoutineTerminalKind, WebhookDestination } from '@/lib/api-types'

const TERMINAL_KINDS: RoutineTerminalKind[] = ['complete', 'handoff']

// Completion export config: when the routine reaches a matching terminal, send the collected
// slot data to a workspace webhook destination. Shared shape edited by the prose host; the
// Form view edits the same config in its own section.
export function RoutineCompletionExportPanel({
  idPrefix,
  value,
  onChange,
  webhookDestinations,
  isLoading,
  error,
  payloadPreview,
}: {
  idPrefix: string
  value: RoutineCompletionExport
  onChange: (next: RoutineCompletionExport) => void
  webhookDestinations: WebhookDestination[]
  isLoading: boolean
  error: string | null
  // What the destination will receive. Shown beside the settings that shape it, so the
  // author can see the effect of a slot or a trigger without leaving the panel.
  payloadPreview?: Record<string, unknown>
}) {
  const toggleTrigger = (kind: RoutineTerminalKind, checked: boolean) => {
    if (!checked && value.triggerKinds.length <= 1 && value.triggerKinds.includes(kind)) return
    const triggerKinds = checked
      ? [...new Set([...value.triggerKinds, kind])]
      : value.triggerKinds.filter((item) => item !== kind)
    onChange({ ...value, triggerKinds })
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Webhook className="h-4 w-4 text-primary" />
          Completion export
        </div>
        <Button
          type="button"
          size="sm"
          variant={value.enabled ? 'outline' : 'default'}
          onClick={() => onChange({ ...value, enabled: !value.enabled })}
        >
          {value.enabled ? 'Disable' : 'Enable'}
        </Button>
      </div>
      {value.enabled ? (
        <div className="space-y-3">
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-exportDestination`}>Webhook destination</Label>
            <Select
              value={value.destinationRef}
              disabled={isLoading || webhookDestinations.length === 0}
              onValueChange={(destinationRef) => onChange({ ...value, destinationRef })}
            >
              <SelectTrigger id={`${idPrefix}-exportDestination`} aria-label="Webhook destination">
                <SelectValue placeholder={isLoading ? 'Loading destinations…' : 'Select destination'} />
              </SelectTrigger>
              <SelectContent>
                {webhookDestinations.map((destination) => (
                  <SelectItem key={destination.id} value={destination.id}>{destination.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {webhookDestinations.length === 0 && !isLoading ? (
              <p className="text-xs text-muted-foreground">Create a workspace webhook destination before publishing this export.</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase text-muted-foreground">Terminal triggers</p>
            <div className="flex flex-wrap gap-4">
              {TERMINAL_KINDS.map((kind) => (
                <div key={kind} className="flex items-center gap-2">
                  <Switch
                    id={`${idPrefix}-exportTrigger-${kind}`}
                    checked={value.triggerKinds.includes(kind)}
                    disabled={value.triggerKinds.length <= 1 && value.triggerKinds.includes(kind)}
                    onCheckedChange={(checked) => toggleTrigger(kind, checked)}
                  />
                  <Label htmlFor={`${idPrefix}-exportTrigger-${kind}`} className="text-sm">{kind}</Label>
                </div>
              ))}
            </div>
          </div>
          {payloadPreview ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase text-muted-foreground">Payload preview</p>
              <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                {JSON.stringify(payloadPreview, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
