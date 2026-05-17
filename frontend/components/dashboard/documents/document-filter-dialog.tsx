'use client'

import { useEffect, useState } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { DocumentSourceListItem } from '@/lib/api'

const ALL_SOURCES_VALUE = '__all__'

interface DocumentFilterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sources: DocumentSourceListItem[]
  currentSourceId: string | null
  onApply: (sourceId: string | null) => void
}

export function DocumentFilterDialog({
  open,
  onOpenChange,
  sources,
  currentSourceId,
  onApply,
}: DocumentFilterDialogProps) {
  const [draftSourceId, setDraftSourceId] = useState<string>(
    currentSourceId ?? ALL_SOURCES_VALUE,
  )

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset draft to current value each time the dialog opens.
      setDraftSourceId(currentSourceId ?? ALL_SOURCES_VALUE)
    }
  }, [open, currentSourceId])

  const handleApply = () => {
    onApply(draftSourceId === ALL_SOURCES_VALUE ? null : draftSourceId)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Filter documents</DialogTitle>
          <DialogDescription>
            Narrow the document list. More filters will be added here over time.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label htmlFor="documents-filter-source" className="text-sm font-medium text-foreground">
              Source
            </label>
            <Select value={draftSourceId} onValueChange={setDraftSourceId}>
              <SelectTrigger id="documents-filter-source" className="w-full">
                <SelectValue placeholder="All sources" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_SOURCES_VALUE}>All sources</SelectItem>
                {sources.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleApply}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
