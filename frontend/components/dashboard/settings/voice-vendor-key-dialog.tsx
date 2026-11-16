'use client'

import { useState } from 'react'

import type { VoiceVendorKeyDialogState } from '@/components/dashboard/settings/use-voice-channel-switch'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { voiceVendorKeyProblemLine } from '@/lib/voice-connection-failures'

// Keyed by the ask, so every ask (a first opening, or a key the vendor refused) starts with an empty key.
function KeyForm({ problem, vendorName, saving, error, onSave, onCancel }: Omit<VoiceVendorKeyDialogState, 'open' | 'ask'>) {
  const [apiKey, setApiKey] = useState('')
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const key = apiKey.trim()
    if (key && !saving) onSave(key)
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{vendorName} API key</DialogTitle>
        <DialogDescription>{voiceVendorKeyProblemLine(problem, vendorName)}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="voiceVendorApiKey">API key</Label>
        <Input
          id="voiceVendorApiKey"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          disabled={saving}
          autoComplete="off"
          autoFocus
        />
        <p className="text-xs text-muted-foreground">Stored for the whole workspace, under Settings → Providers.</p>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button type="submit" disabled={apiKey.trim() === ''} loading={saving}>Save key</Button>
      </DialogFooter>
    </form>
  )
}

/** Asks for the voice vendor's API key when turning voice on needs one. */
export function VoiceVendorKeyDialog({ open, ask, ...form }: VoiceVendorKeyDialogState) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) form.onCancel() }}>
      <DialogContent className="sm:max-w-md">
        <KeyForm key={ask} {...form} />
      </DialogContent>
    </Dialog>
  )
}
