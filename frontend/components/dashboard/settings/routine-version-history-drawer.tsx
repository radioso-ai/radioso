'use client'

import { History } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { RoutineDefinition } from '@/lib/api-types'

const formatVersionDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

export interface RoutineVersionHistoryDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  versions: RoutineDefinition[]
  currentId?: string
  onOpenVersion: (routineId: string) => void
}

/**
 * Lists every version in a routine's lineage on its own surface (opened from the editor's
 * overflow menu) so the editor page stays focused on the routine being authored. Each row
 * carries its own control: open that version in the editor.
 */
export function RoutineVersionHistoryDrawer({
  open,
  onOpenChange,
  versions,
  currentId,
  onOpenVersion,
}: RoutineVersionHistoryDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[95vw] gap-0 p-0 sm:!max-w-[560px]">
        <SheetHeader className="border-b border-border p-5 pr-12">
          <SheetTitle className="flex items-center gap-2 text-base font-medium">
            <History className="h-4 w-4 text-muted-foreground" />
            Version history
          </SheetTitle>
          <SheetDescription>Every version in this routine&apos;s lineage. Open one to view or edit it.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <ul className="space-y-1">
            {versions.map((version) => {
              const isCurrent = version.id === currentId
              return (
                <li
                  key={version.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md px-3 py-2.5 hover:bg-muted/60"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">v{version.version}</span>
                    <Badge variant="outline">{version.status}</Badge>
                    <span className="text-xs text-muted-foreground">{formatVersionDate(version.updatedAt)}</span>
                  </span>
                  {isCurrent ? (
                    <span className="text-xs font-medium text-muted-foreground">Current view</span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onOpenVersion(version.id)}
                    >
                      Open
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  )
}
