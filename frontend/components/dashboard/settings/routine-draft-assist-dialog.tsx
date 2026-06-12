'use client'

import { FileText } from 'lucide-react'

import { Button } from '@/components/ui/button'
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
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Draft from procedure</h4>
          <p className="text-xs text-muted-foreground">Paste an SOP to propose an editable routine draft.</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenChange(!isOpen)}
          disabled={isDrafting}
          aria-expanded={isOpen}
          aria-controls="routineDraftAssistPanel"
        >
          <FileText className="mr-2 h-4 w-4" />
          Draft from procedure
        </Button>
      </div>
      {isOpen ? (
        <div id="routineDraftAssistPanel" className="space-y-2">
          <Label htmlFor="routineDraftAssistProse">Procedure text</Label>
          <Textarea
            id="routineDraftAssistProse"
            aria-label="Procedure text for routine drafting assist"
            value={prose}
            onChange={(event) => onProseChange(event.target.value)}
            rows={6}
            disabled={isDrafting}
          />
          <div className="flex justify-end gap-2">
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
              {isDrafting ? <Spinner className="mr-2 h-4 w-4" /> : <FileText className="mr-2 h-4 w-4" />}
              Load proposal
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
