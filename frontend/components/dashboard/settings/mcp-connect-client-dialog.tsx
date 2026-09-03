'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'

import { defaultExpiryDate, expiryInputToIso } from '@/components/dashboard/settings/api-access-dialogs'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import {
  DEFAULT_MCP_CLIENT_ID,
  MCP_CLIENT_SETUPS,
  getMcpClientSetup,
  type McpClientId,
  type McpClientSetup,
} from '@/lib/mcp-client-setups'
import { cn } from '@/lib/utils'

/**
 * Picks the client first: the client decides the setup steps and the shape of the
 * configuration the operator pastes, so it is chosen before the credential exists.
 */
export function McpConnectClientDialog({
  error,
  isSubmitting,
  onOpenChange,
  onSubmit,
}: {
  error: string | null
  isSubmitting: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: { setup: McpClientSetup; label: string; expiresAt: string }) => void
}) {
  const [clientId, setClientId] = useState<McpClientId>(DEFAULT_MCP_CLIENT_ID)
  const [label, setLabel] = useState(() => getMcpClientSetup(DEFAULT_MCP_CLIENT_ID).name)
  const [isLabelEdited, setIsLabelEdited] = useState(false)
  const [expiry, setExpiry] = useState(() => defaultExpiryDate(90))
  const expiresAt = expiryInputToIso(expiry)

  const pickClient = (nextClientId: McpClientId) => {
    setClientId(nextClientId)
    if (!isLabelEdited) setLabel(getMcpClientSetup(nextClientId).name)
  }

  const submitDisabled = isSubmitting || !label.trim() || !expiresAt

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect a client</DialogTitle>
          <DialogDescription>Each client gets its own credential, so you can rotate or revoke one without touching the others.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (submitDisabled || !expiresAt) return
            onSubmit({ setup: getMcpClientSetup(clientId), label: label.trim(), expiresAt })
          }}
        >
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-foreground">Client</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {MCP_CLIENT_SETUPS.map((setup) => (
                <label
                  key={setup.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm',
                    clientId === setup.id ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground',
                  )}
                >
                  <input
                    type="radio"
                    name="mcp-client"
                    value={setup.id}
                    checked={clientId === setup.id}
                    onChange={() => pickClient(setup.id)}
                  />
                  {setup.name}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-connect-label">Label</Label>
            <Input
              id="mcp-connect-label"
              value={label}
              onChange={(event) => {
                setIsLabelEdited(true)
                setLabel(event.target.value)
              }}
            />
          </div>

          <div className="space-y-1.5 sm:max-w-[12rem]">
            <Label htmlFor="mcp-connect-expiry">Expires</Label>
            <Input id="mcp-connect-expiry" type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
          </div>

          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={submitDisabled}>
              {isSubmitting ? <Spinner className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
              Create credential &amp; get config
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
