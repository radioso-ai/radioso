'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { updateExposure } from '@/lib/routine-document-edits'
import type { RoutineBlockDoc } from '@/lib/routine-prose'

// Lives inside the "Starts when" editor: exposure is a second way a routine starts, beside
// the trigger. Validation notes (a name outside the grammar, a reserved or duplicate name, a
// gated activation) arrive as routine-level diagnostics and render in the list above the tabs.
export function RoutineExposureEditor({ doc, apply }: {
  doc: RoutineBlockDoc
  apply: (edit: (current: RoutineBlockDoc) => RoutineBlockDoc) => void
}) {
  const exposure = doc.exposure
  const enabled = exposure?.enabled ?? false
  return <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3" aria-label="Tool exposure">
    <div className="flex items-start justify-between gap-3">
      <div>
        <Label htmlFor="routine-exposure-enabled">Expose as a tool</Label>
        <p className="mt-1 text-xs text-muted-foreground">Calling AI agents start this routine by name, with its information filled in.</p>
      </div>
      <Switch id="routine-exposure-enabled" aria-label="Expose as a tool" checked={enabled} onCheckedChange={(checked) => apply((current) => updateExposure(current, { enabled: checked }))} />
    </div>
    {enabled ? <div className="grid gap-2 sm:grid-cols-[minmax(0,240px)_1fr]">
      <label className="text-xs font-medium text-foreground">Tool name<Input aria-label="Tool name" className="mt-1 font-mono" value={exposure?.toolName ?? ''} onChange={(event) => apply((current) => updateExposure(current, { toolName: event.target.value }))} placeholder="start_return" spellCheck={false} /></label>
      <label className="text-xs font-medium text-foreground">Description<Input aria-label="Tool description" className="mt-1" value={exposure?.description ?? ''} onChange={(event) => apply((current) => updateExposure(current, { description: event.target.value }))} placeholder="When a calling agent should use it" /></label>
      <p className="text-xs text-muted-foreground sm:col-span-2">Lower-case letters, digits, and underscores. The name is fixed once the agent is published with it.</p>
    </div> : null}
  </div>
}
