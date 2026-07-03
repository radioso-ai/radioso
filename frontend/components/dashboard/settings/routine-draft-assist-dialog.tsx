'use client'

import { WandSparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'

export function RoutineDraftAssistDialog({
  isOpen,
  isDrafting,
  prose,
  onOpenChange,
  onProseChange,
  onLoadProposal,
}: {
  isOpen: boolean
  isDrafting: boolean
  prose: string
  onOpenChange: (isOpen: boolean) => void
  onProseChange: (prose: string) => void
  onLoadProposal: () => void
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Draft with AI</DialogTitle>
          <DialogDescription>Paste the procedure or SOP. The proposal replaces the current editable draft.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="routineDraftAssistProse">Procedure text</Label>
          <Textarea
            id="routineDraftAssistProse"
            aria-label="Procedure text for routine drafting assist"
            value={prose}
            onChange={(event) => onProseChange(event.target.value)}
            rows={10}
            disabled={isDrafting}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isDrafting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onLoadProposal}
            disabled={isDrafting || !prose.trim()}
          >
            {isDrafting ? <Spinner className="mr-2 h-4 w-4" /> : <WandSparkles className="mr-2 h-4 w-4" />}
            Load proposal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
