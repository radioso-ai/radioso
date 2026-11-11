'use client'

import { useRef, useState, type ReactNode } from 'react'

import { DirectiveConflicts } from '@/components/dashboard/settings/directive-conflicts'
import { focusBuiltInRow, focusDirectiveRow } from '@/components/dashboard/settings/directive-list'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import type { BuiltInDirective, Directive } from '@/lib/api'
import type { BuiltInDefaultEntry, DirectiveRow } from '@/lib/directive-list-view-model'
import { directiveSurfaceSummary } from '@/lib/directive-surfaces'
import { diffWords, WORD_DIFF_SIMILARITY_THRESHOLD } from '@/lib/word-diff'

export type DirectiveSheetTarget =
  | { kind: 'row'; row: DirectiveRow }
  | { kind: 'default'; entry: BuiltInDefaultEntry }

export type DirectiveSheetActions = {
  // Every directive mutation waits on `isRowPending`: the editor and the conflict actions resend
  // a directive in full, and a toggle still in flight would be overwritten by that copy.
  isRowPending: (directiveId: string) => boolean
  isSaving: boolean
  onToggleEnabled: (directive: Directive, enabled: boolean) => void
  onEdit: (directive: Directive) => void
  onDelete: (directive: Directive) => void
  onCustomize: (builtIn: BuiltInDirective) => void
  onOpenDirective: (directiveId: string) => void
  onSupersede: (winner: Directive, loser: Directive) => void
  onMakeConditional: (directive: Directive) => void
}

type VersionInUse = 'default' | 'yours'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  )
}

// The instruction keeps the line breaks its author wrote, so it reads back as written.
function InstructionText({ children }: { children: ReactNode }) {
  return <p className="whitespace-pre-wrap break-words">{children}</p>
}

function SheetFrame({
  title,
  subtitle,
  headerEnd,
  footer,
  children,
}: {
  title: string
  subtitle: string
  headerEnd?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      {/* The sheet's own close control sits in the top-right corner, so the header leaves it room. */}
      <SheetHeader className="flex-row items-start justify-between gap-3 pr-12">
        <div className="min-w-0 space-y-1">
          <SheetTitle className="break-words font-display text-xl">{title}</SheetTitle>
          <SheetDescription>{subtitle}</SheetDescription>
        </div>
        {headerEnd}
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4">{children}</div>
      {footer ? <SheetFooter className="flex-row items-center gap-2 border-t border-border">{footer}</SheetFooter> : null}
    </>
  )
}

function WordDiffText({ from, to }: { from: string; to: string }) {
  const { segments } = diffWords(from, to)
  return (
    <p className="whitespace-pre-wrap break-words">
      {segments.map((segment, index) => {
        if (segment.kind === 'same') return <span key={index}>{segment.gap}{segment.text}</span>
        const Mark = segment.kind === 'added' ? 'ins' : 'del'
        return (
          <span key={index}>
            {segment.gap}
            <Mark
              className={segment.kind === 'added'
                ? 'rounded-sm bg-emerald-500/15 px-0.5 text-emerald-900 no-underline dark:text-emerald-100'
                : 'rounded-sm bg-destructive/10 px-0.5 text-destructive line-through'}
            >
              {segment.text}
            </Mark>
          </span>
        )
      })}
    </p>
  )
}

function AuthoredSheet({ row, actions }: { row: DirectiveRow; actions: DirectiveSheetActions }) {
  const { directive } = row
  const isPending = actions.isRowPending(directive.id)
  const details: Array<[string, string]> = [
    ['Priority', directive.priority == null ? 'Default' : String(directive.priority)],
    ['Applies to', directiveSurfaceSummary(directive.surfaces)],
    ...(row.replaces.length > 0 ? [['Replaces', row.replaces.join(', ')] as [string, string]] : []),
  ]
  return (
    <SheetFrame
      title={directive.name}
      subtitle={directive.enabled ? 'On' : 'Off'}
      headerEnd={(
        <Switch
          checked={directive.enabled}
          onCheckedChange={(enabled) => actions.onToggleEnabled(directive, enabled)}
          disabled={isPending}
          aria-label={`${directive.enabled ? 'Disable' : 'Enable'} ${directive.name}`}
        />
      )}
      footer={(
        <>
          {/* The editor opens from this directive's current values and resends them on save, so
              editing while a toggle is still in flight would save the pre-toggle state back over it. */}
          <Button type="button" variant="outline" disabled={isPending} onClick={() => actions.onEdit(directive)} aria-label={`Edit ${directive.name}`}>
            Edit
          </Button>
          <Button type="button" variant="ghost" className="ml-auto text-destructive hover:text-destructive" disabled={isPending} onClick={() => actions.onDelete(directive)} aria-label={`Delete ${directive.name}`}>
            Delete
          </Button>
        </>
      )}
    >
      <DirectiveConflicts
        entries={row.conflicts}
        focusId={directive.id}
        onSupersede={actions.onSupersede}
        onMakeConditional={actions.onMakeConditional}
        isSaving={actions.isSaving}
        isRowPending={actions.isRowPending}
      />
      <Field label="When">
        {directive.condition.kind === 'contextual' ? directive.condition.description : 'Always'}
      </Field>
      <Field label="Instruction"><InstructionText>{directive.action}</InstructionText></Field>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 border-t border-border pt-4 text-sm">
        {details.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </SheetFrame>
  )
}

function CustomizedSheet({
  row,
  builtIn,
  actions,
}: {
  row: DirectiveRow
  builtIn: BuiltInDirective
  actions: DirectiveSheetActions
}) {
  const { directive } = row
  const isPending = actions.isRowPending(directive.id)
  const inUse: VersionInUse = directive.enabled ? 'yours' : 'default'
  const diff = diffWords(builtIn.action, directive.action)
  const isComparable = diff.similarity >= WORD_DIFF_SIMILARITY_THRESHOLD
  return (
    <SheetFrame
      title={row.title}
      subtitle="Radioso default, customized · Always"
      footer={(
        <>
          <Button type="button" variant="outline" disabled={isPending} onClick={() => actions.onEdit(directive)}>
            Edit your version
          </Button>
          <Button type="button" variant="ghost" className="ml-auto text-destructive hover:text-destructive" disabled={isPending} onClick={() => actions.onDelete(directive)}>
            Delete your version
          </Button>
        </>
      )}
    >
      <DirectiveConflicts
        entries={row.conflicts}
        focusId={directive.id}
        onSupersede={actions.onSupersede}
        onMakeConditional={actions.onMakeConditional}
        isSaving={actions.isSaving}
        isRowPending={actions.isRowPending}
      />
      <Field label="In use">
        {/* Choosing a version flips the customization on or off; its text is kept either way. */}
        <SegmentedControl<VersionInUse>
          aria-label="Version in use"
          value={inUse}
          disabled={isPending}
          onValueChange={(next) => {
            if (next !== inUse) actions.onToggleEnabled(directive, next === 'yours')
          }}
          options={[
            { value: 'default', label: 'Radioso default' },
            { value: 'yours', label: 'Your version' },
          ]}
        />
      </Field>
      {isComparable ? (
        <Field label={diff.changes === 0 ? 'Your version · same as the default' : `Your version · ${diff.changes} ${diff.changes === 1 ? 'change' : 'changes'} from the default`}>
          <WordDiffText from={builtIn.action} to={directive.action} />
        </Field>
      ) : (
        <>
          <Field label="Your version"><InstructionText>{directive.action}</InstructionText></Field>
          <Field label="Radioso default"><InstructionText>{builtIn.action}</InstructionText></Field>
        </>
      )}
    </SheetFrame>
  )
}

function DefaultSheet({ entry, actions }: { entry: BuiltInDefaultEntry; actions: DirectiveSheetActions }) {
  const { builtIn, replacedBy } = entry
  const isFullyReplaced = replacedBy?.condition.kind === 'always'
  return (
    <SheetFrame
      title={entry.title}
      subtitle="Radioso default · Always"
      footer={
        // An unconditional replacer already retires this default; a second one would only stack
        // another rule on a built-in nothing is using.
        isFullyReplaced ? null : (
          <Button type="button" variant="outline" onClick={() => actions.onCustomize(builtIn)} aria-label={`Customize ${entry.title}`}>
            Customize
          </Button>
        )
      }
    >
      {replacedBy ? (
        <p className="text-sm text-muted-foreground">
          Replaced by{' '}
          <button
            type="button"
            className="font-medium text-foreground underline-offset-4 hover:underline"
            onClick={() => actions.onOpenDirective(replacedBy.id)}
          >
            {replacedBy.name}
          </button>
          {replacedBy.condition.kind === 'contextual'
            ? <> only when: {replacedBy.condition.description}. Otherwise this default still applies.</>
            : '.'}
        </p>
      ) : null}
      {builtIn.description ? <p className="text-sm text-muted-foreground">{builtIn.description}</p> : null}
      <Field label="Instruction"><InstructionText>{builtIn.action}</InstructionText></Field>
    </SheetFrame>
  )
}

function SheetBody({ target, actions }: { target: DirectiveSheetTarget; actions: DirectiveSheetActions }) {
  if (target.kind === 'default') return <DefaultSheet entry={target.entry} actions={actions} />
  const { row } = target
  return row.kind === 'customized'
    ? <CustomizedSheet row={row} builtIn={row.builtIn} actions={actions} />
    : <AuthoredSheet row={row} actions={actions} />
}

export function DirectiveDetailSheet({
  target,
  actions,
  onClose,
}: {
  target: DirectiveSheetTarget | null
  actions: DirectiveSheetActions
  onClose: () => void
}) {
  // The sheet slides out after `target` clears. Keeping the last target mounted lets it leave with
  // its content instead of emptying first.
  const [lastTarget, setLastTarget] = useState(target)
  if (target && target !== lastTarget) setLastTarget(target)
  const shown = target ?? lastTarget
  // The sheet has no trigger to hand focus back to, so a dismissal returns it to the row that
  // opened the sheet. Closing to open an editor leaves focus alone: the editor owns it then.
  const wasDismissed = useRef(false)

  const returnFocus = () => {
    if (!shown) return
    if (shown.kind === 'default') focusBuiltInRow(shown.entry.builtIn.name)
    else focusDirectiveRow(shown.row.id)
  }

  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => {
        if (open) return
        wasDismissed.current = true
        onClose()
      }}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (wasDismissed.current) returnFocus()
          wasDismissed.current = false
        }}
      >
        {shown ? <SheetBody target={shown} actions={actions} /> : null}
      </SheetContent>
    </Sheet>
  )
}
