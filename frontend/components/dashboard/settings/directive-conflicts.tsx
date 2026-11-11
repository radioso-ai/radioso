'use client'

import { TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { Directive } from '@/lib/api'
import type { DirectiveConflictEntry } from '@/lib/directive-list-view-model'
import { directiveSurfacesOverlap } from '@/lib/directive-surfaces'

// Directive names are the operator's own and can be long, so the actions wrap inside the sheet
// instead of running off its edge.
const ACTION_CLASS = 'h-auto min-h-8 whitespace-normal py-1 text-left'

// The conflicts a verdict found for one directive, with the ways to settle them. A verdict is
// always between its subject and the directive each conflict names, so the same three actions
// are offered whichever of the two the operator opened.
export function DirectiveConflicts({
  entries,
  focusId,
  onSupersede,
  onMakeConditional,
  isSaving,
  isRowPending,
}: {
  entries: DirectiveConflictEntry[]
  // The directive whose sheet this renders in, so each conflict names the other side.
  focusId: string
  onSupersede: (winner: Directive, loser: Directive) => void
  onMakeConditional: (directive: Directive) => void
  isSaving: boolean
  // Each action resubmits one directive in full, from the copy this component is holding. A row
  // mutation in flight for that directive is about to change what "in full" means, so the action
  // waits rather than writing a stale value back over it.
  isRowPending: (directiveId: string) => boolean
}) {
  if (entries.length === 0) return null

  return (
    <div
      className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100"
      role="status"
    >
      {entries.map(({ conflict, subject, existing, existingName }) => {
        const otherName = subject && subject.id !== focusId ? subject.name : existingName
        const canResolve = subject
          && existing
          && subject.id !== existing.id
          && directiveSurfacesOverlap(subject.surfaces, existing.surfaces)
        return (
          <div key={`${conflict.directiveName}-${conflict.reason}`} className="space-y-2">
            <p className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">Conflicts with {otherName}.</span> {conflict.reason}
              </span>
            </p>
            {subject && existing && canResolve ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={ACTION_CLASS}
                  disabled={isSaving || isRowPending(subject.id)}
                  onClick={() => onSupersede(subject, existing)}
                  aria-label={`${subject.name} supersedes ${existing.name}`}
                >
                  {subject.name} supersedes {existing.name}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={ACTION_CLASS}
                  disabled={isSaving || isRowPending(existing.id)}
                  onClick={() => onSupersede(existing, subject)}
                  aria-label={`${existing.name} supersedes ${subject.name}`}
                >
                  {existing.name} supersedes {subject.name}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={ACTION_CLASS}
                  disabled={isSaving || isRowPending(subject.id)}
                  onClick={() => onMakeConditional(subject)}
                  aria-label={`Make ${subject.name} apply only conditionally`}
                >
                  Make {subject.name} apply only conditionally
                </Button>
              </div>
            ) : null}
          </div>
        )
      })}
      {entries[0].rationale ? <p className="text-xs opacity-80">{entries[0].rationale}</p> : null}
    </div>
  )
}
