'use client'

import { useContext } from 'react'

import { RoutineSkillCatalogContext } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { RoutineBlockSlot } from '@/lib/routine-prose'
import { saveTargetsForField } from '@/lib/routine-save-targets'

type SaveTo = NonNullable<RoutineBlockSlot['saveTo']>

const NO_SAVE = '__none__'

const SCOPE_LABELS: Record<SaveTo['scope'], string> = {
  conversation: 'This conversation',
  person: 'The verified person',
}

// Where a field's value is kept once the routine finishes or hands off (#1884). Only the author
// picks the attribute, from the agent's attributes it may save to; a stored one that no longer
// qualifies stays visible so the author sees what the routine says, and validation reports it.
export function RoutineSlotSaveTo({ slot, onChange }: {
  slot: RoutineBlockSlot
  onChange: (saveTo: SaveTo | null) => void
}) {
  const { saveTargets } = useContext(RoutineSkillCatalogContext)
  const saveTo = slot.saveTo
  const targets = saveTargetsForField(saveTargets, slot)
  const unlisted = saveTo && !targets.some((target) => target.name === saveTo.contextVariable) ? saveTo.contextVariable : null
  return (
    <div className="flex flex-wrap items-center gap-2 sm:col-span-4">
      <Label htmlFor={`slot-${slot.stableSlotId}-save-to`} className="text-xs">Save to</Label>
      <Select
        value={saveTo?.contextVariable ?? NO_SAVE}
        onValueChange={(value) => onChange(value === NO_SAVE ? null : { contextVariable: value, scope: saveTo?.scope ?? 'conversation' })}
      >
        <SelectTrigger id={`slot-${slot.stableSlotId}-save-to`} aria-label={`Slot ${slot.key} save to`} className="h-8 w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_SAVE}>Don&apos;t save</SelectItem>
          {targets.map((target) => <SelectItem key={target.name} value={target.name}>{target.name}</SelectItem>)}
          {unlisted ? <SelectItem value={unlisted}>{`${unlisted} (can't save here)`}</SelectItem> : null}
        </SelectContent>
      </Select>
      {saveTo ? (
        <Select value={saveTo.scope} onValueChange={(scope) => onChange({ ...saveTo, scope: scope as SaveTo['scope'] })}>
          <SelectTrigger aria-label={`Slot ${slot.key} save for`} className="h-8 w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SCOPE_LABELS) as SaveTo['scope'][]).map((scope) => <SelectItem key={scope} value={scope}>{SCOPE_LABELS[scope]}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : null}
      {targets.length === 0 && !saveTo ? <p className="text-xs text-muted-foreground">No attribute of this type to save to.</p> : null}
    </div>
  )
}
