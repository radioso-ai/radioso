'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// The completion (and, when the routine hands off, handoff) message the agent says when the
// routine ends. These are terminal-level fields the prose body does not encode, so the prose
// editors render them here; the Form editor edits the same terminals in its own terminal rows.
export function RoutineTerminalMessages({
  idPrefix,
  completionMessage,
  onCompletionMessageChange,
  handoffMessage,
  onHandoffMessageChange,
  showHandoff,
}: {
  idPrefix: string
  completionMessage: string
  onCompletionMessageChange: (value: string) => void
  handoffMessage: string
  onHandoffMessageChange: (value: string) => void
  showHandoff: boolean
}) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-completionMessage`}>Completion message</Label>
        <Input
          id={`${idPrefix}-completionMessage`}
          value={completionMessage}
          onChange={(event) => onCompletionMessageChange(event.target.value)}
          placeholder="What the agent says when the routine finishes (optional)"
        />
      </div>
      {showHandoff ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-handoffMessage`}>Handoff message</Label>
          <Input
            id={`${idPrefix}-handoffMessage`}
            value={handoffMessage}
            onChange={(event) => onHandoffMessageChange(event.target.value)}
            placeholder="What the agent says when it hands off to a person"
          />
        </div>
      ) : null}
    </div>
  )
}
