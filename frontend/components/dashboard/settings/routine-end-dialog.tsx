'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { slugifyVariableKey } from '@/lib/routine-prose'

// Name an ending and give it its own completion message. A blank name is the default ending
// (the primary complete terminal, whose message is the header field); a name makes it an
// additional completion whose message is carried here, so a branch can finish with its own copy.
export function EndDialog({
  open,
  onOpenChange,
  initialName,
  initialMessage,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialName: string
  initialMessage: string
  onConfirm: (name: string, message: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [message, setMessage] = useState(initialMessage)
  // A named ending becomes a terminal id, so it can't reuse the reserved `done`/`handoff` refs —
  // that would collide with the default completion or the handoff terminal. (The backend
  // validator also rejects any id shared by two nodes, covering collisions with step ids.)
  const reservedCollision = name.trim().length > 0 && (slugifyVariableKey(name.trim()) === 'done' || slugifyVariableKey(name.trim()) === 'handoff')
  const confirm = () => {
    if (reservedCollision) return
    onConfirm(name, message)
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ending</DialogTitle>
          <DialogDescription>Leave the name blank for the routine&apos;s default ending. Give it a name to add a separate ending with its own completion message.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="endName">Ending name (optional)</Label>
            <Input id="endName" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. ineligible" />
            {reservedCollision ? (
              <p className="text-xs text-destructive">That name is reserved — pick a different name for this ending.</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="endMessage">Completion message (optional)</Label>
            <Input id="endMessage" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="What the agent says at this ending" />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" onClick={confirm} disabled={reservedCollision}>Save ending</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
