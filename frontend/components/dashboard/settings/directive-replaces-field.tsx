'use client'

import * as Popover from '@radix-ui/react-popover'
import { useMemo, useState } from 'react'
import { Check, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export type DirectiveReplaceCandidate = {
  name: string
  description: string | null
}

// Structural substring search over names an operator wrote, not product vocabulary: nothing here
// decides behavior, it only narrows a list the operator is already looking at.
const matchesQuery = (candidate: DirectiveReplaceCandidate, query: string): boolean => {
  if (query === '') return true
  const needle = query.toLowerCase()
  return candidate.name.toLowerCase().includes(needle)
    || (candidate.description?.toLowerCase().includes(needle) ?? false)
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: DirectiveReplaceCandidate
  checked: boolean
  onToggle: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={`Replace ${candidate.name}`}
      onClick={() => onToggle(!checked)}
      className={cn(
        'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted',
        checked ? 'bg-muted/60' : null,
      )}
    >
      <Check className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', checked ? 'text-foreground' : 'text-transparent')} />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{candidate.name}</span>
        {candidate.description ? (
          // One line each: a wrapped description pushes the next group's heading past the scroll
          // box, so the list reads as though it ends at the built-ins.
          // `line-clamp-1` sets its own display, so pairing it with `block` would cancel it.
          <span className="line-clamp-1 text-xs text-muted-foreground">{candidate.description}</span>
        ) : null}
      </span>
    </button>
  )
}

function CandidateGroup({
  heading,
  candidates,
  selected,
  onToggle,
}: {
  heading: string
  candidates: DirectiveReplaceCandidate[]
  selected: string[]
  onToggle: (name: string, checked: boolean) => void
}) {
  if (candidates.length === 0) return null
  return (
    <div className="space-y-1">
      <p className="px-2 text-xs font-medium text-muted-foreground">{heading}</p>
      {candidates.map((candidate) => (
        <CandidateRow
          key={candidate.name}
          candidate={candidate}
          checked={selected.includes(candidate.name)}
          onToggle={(checked) => onToggle(candidate.name, checked)}
        />
      ))}
    </div>
  )
}

// Which directives this one overrides. The selection is the field; the candidate list lives behind
// a filterable popover so an agent with fifty directives reads the same as one with two.
export function DirectiveReplacesField({
  builtIns,
  authored,
  selected,
  onToggle,
}: {
  builtIns: DirectiveReplaceCandidate[]
  authored: DirectiveReplaceCandidate[]
  selected: string[]
  onToggle: (name: string, checked: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const builtInNames = useMemo(() => new Set(builtIns.map((candidate) => candidate.name)), [builtIns])
  const matchingBuiltIns = useMemo(
    () => builtIns.filter((candidate) => matchesQuery(candidate, query)),
    [builtIns, query],
  )
  const matchingAuthored = useMemo(
    () => authored.filter((candidate) => matchesQuery(candidate, query)),
    [authored, query],
  )

  if (builtIns.length === 0 && authored.length === 0) return null

  const hasMatches = matchingBuiltIns.length > 0 || matchingAuthored.length > 0

  return (
    <div className="space-y-1.5">
      <Label>Replaces</Label>
      <p className="text-xs text-muted-foreground">
        Pick the directives this one overrides. While it applies, they stand down; the rest of the time they
        still apply.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {selected.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing yet — this directive applies alongside the others.</p>
        ) : (
          selected.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
            >
              {name}
              {builtInNames.has(name) ? <span className="text-muted-foreground">built-in</span> : null}
              <button
                type="button"
                aria-label={`Stop replacing ${name}`}
                onClick={() => onToggle(name, false)}
                className="rounded-full text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        )}
        <Popover.Root
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) setQuery('')
          }}
        >
          <Popover.Trigger asChild>
            <Button type="button" variant="outline" size="sm">
              Choose directives
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              aria-label="Replaces"
              align="start"
              sideOffset={6}
              collisionPadding={12}
              // The panel opens inside a scrolling dialog; without this it renders its full height
              // over the backdrop below the dialog's edge.
              style={{ maxHeight: 'var(--radix-popover-content-available-height)' }}
              className="z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 overflow-hidden rounded-lg border bg-popover p-2 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
            >
              <Input
                aria-label="Filter directives"
                placeholder="Filter directives"
                value={query}
                autoFocus
                className="shrink-0"
                onChange={(event) => setQuery(event.target.value)}
              />
              {hasMatches ? (
                <div className="max-h-64 min-h-0 flex-1 space-y-2 overflow-y-auto">
                  <CandidateGroup
                    heading="Built-in behaviors"
                    candidates={matchingBuiltIns}
                    selected={selected}
                    onToggle={onToggle}
                  />
                  <CandidateGroup
                    heading="Your other directives"
                    candidates={matchingAuthored}
                    selected={selected}
                    onToggle={onToggle}
                  />
                </div>
              ) : (
                <p className="px-2 py-3 text-xs text-muted-foreground">No directives match &quot;{query}&quot;.</p>
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </div>
  )
}
