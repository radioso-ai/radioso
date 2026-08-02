'use client'

import { Variable } from 'lucide-react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { RoutineValidationDiagnostic } from '@/lib/api'

export function RoutineDiagnosticList({ diagnostics }: { diagnostics: RoutineValidationDiagnostic[] }) {
  if (diagnostics.length === 0) return null
  return (
    <div className="space-y-1" role="status">
      {/* One location+code pair can legitimately repeat (e.g. two unreachable options on
          one approval step), so the index keeps the keys unique. */}
      {diagnostics.map((diagnostic, index) => (
        <p key={`${diagnostic.location}-${diagnostic.code}-${index}`} className="text-xs text-destructive">
          {diagnostic.message}
        </p>
      ))}
    </div>
  )
}

export function RoutineVariableInsertButton({
  slotKeys,
  ariaLabel = 'Insert variable',
  onInsert,
}: {
  slotKeys: string[]
  ariaLabel?: string
  onInsert: (token: string) => void
}) {
  if (slotKeys.length === 0) return null
  return (
    <Select onValueChange={(key) => onInsert(`{{slot.${key}}}`)}>
      <SelectTrigger aria-label={ariaLabel} className="h-8 w-[160px]">
        <Variable className="mr-2 h-4 w-4" />
        <SelectValue placeholder="Insert variable" />
      </SelectTrigger>
      <SelectContent>
        {slotKeys.map((key) => (
          <SelectItem key={key} value={key}>{key}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
