'use client'

import { useState } from 'react'

import { ROUTINE_DEFINITION_LIMITS } from '@radioso/routine-definition'

import { RoutineInstructionEditor } from '@/components/dashboard/settings/routine-chip-editor'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { instructionToProseParagraphs, proseParagraphsToInstruction } from '@/lib/routine-document'
import type { EndingNotice } from '@/lib/routine-document-edits'
import { blockSegmentsToInstruction, instructionToBlockSegments, type ChipDocVariable, type ProseParagraph, type RoutineBlockEnding } from '@/lib/routine-prose'

// One notice text, edited with the same chip editor as a step instruction, so `@` inserts a
// collected value as `{{slot.<key>}}`. A notice reads values the routine collects and never
// collects one, so `@` offers only the slots the routine declares: no new slot, no context
// variable. The editor is uncontrolled; it reads the text once, and reports only real edits so
// opening an ending never writes a notice the author did not type.
function NoticeTextField({ label, placeholder, value, variables, maxLength, onChange }: {
  label: string
  placeholder: string
  value: string | null
  variables: ChipDocVariable[]
  maxLength: number
  onChange: (text: string) => void
}) {
  const [initialContent] = useState(() => instructionToProseParagraphs(instructionToBlockSegments(value ?? '')))
  const report = (paragraphs: ProseParagraph[]) => {
    const text = blockSegmentsToInstruction(proseParagraphsToInstruction(paragraphs))
    if (text !== (value ?? '')) onChange(text)
  }
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{label}</p>
      <div className="rounded-md border border-input px-2">
        <RoutineInstructionEditor
          initialContent={initialContent}
          variables={variables}
          offerContextVariables={false}
          maxLength={maxLength}
          onChange={report}
          ariaLabel={label}
          placeholder={placeholder}
        />
      </div>
    </div>
  )
}

// What the team is told when the routine ends here. A hand-off always notifies, so its switch
// stays on; a finish notifies only when the author turns it on. Blank text means the default.
export function RoutineEndingNoticeEditor({ ending, variables, onChange }: {
  ending: RoutineBlockEnding
  variables: ChipDocVariable[]
  onChange: (notice: EndingNotice | null) => void
}) {
  const handoff = ending.kind === 'handoff'
  const notice = ending.operatorNotice
  const notifies = handoff || notice !== undefined
  const id = `ending-${ending.stableStepId}-notice`
  const update = (patch: Partial<EndingNotice>) => onChange({ subject: notice?.subject ?? null, intro: notice?.intro ?? null, ...patch })

  return (
    <div className="w-full space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Switch
          id={`${id}-enabled`}
          checked={notifies}
          disabled={handoff}
          onCheckedChange={(checked) => onChange(checked ? { subject: null, intro: null } : null)}
        />
        <Label htmlFor={`${id}-enabled`} className="text-sm">Notify the team</Label>
        {handoff ? <span className="text-xs text-muted-foreground">Always on for a hand-off.</span> : null}
      </div>
      {notifies ? (
        <div className="space-y-2">
          <NoticeTextField
            label="Subject"
            placeholder="Default subject. Type @ to insert a value."
            value={notice?.subject ?? null}
            variables={variables}
            maxLength={ROUTINE_DEFINITION_LIMITS.operatorNoticeSubject}
            onChange={(subject) => update({ subject })}
          />
          <NoticeTextField
            label="Intro"
            placeholder="Optional. Type @ to insert a value."
            value={notice?.intro ?? null}
            variables={variables}
            maxLength={ROUTINE_DEFINITION_LIMITS.operatorNoticeIntro}
            onChange={(intro) => update({ intro })}
          />
          <p className="text-xs text-muted-foreground">Every collected value is listed below the intro.</p>
        </div>
      ) : null}
    </div>
  )
}
