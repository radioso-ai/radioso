'use client'

import { useMemo, type ReactNode } from 'react'

import { DirectiveConflicts } from '@/components/dashboard/settings/directive-conflicts'
import { focusBuiltInRow, focusDirectiveRow } from '@/components/dashboard/settings/directive-list'
import {
  QuietDetailSheet,
  QuietSheetDetails,
  QuietSheetField,
  QuietSheetFrame,
} from '@/components/dashboard/settings/quiet-detail-sheet'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import type { BuiltInDirective, Directive } from '@/lib/api'
import type { BuiltInDefaultEntry, DirectiveRow } from '@/lib/directive-list-view-model'
import { directiveSurfaceSummary } from '@/lib/directive-surfaces'
import { diffWords, WORD_DIFF_SIMILARITY_THRESHOLD, type WordDiff } from '@/lib/word-diff'

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

// The instruction keeps the line breaks its author wrote, so it reads back as written.
function InstructionText({ children }: { children: ReactNode }) {
  return <p className="whitespace-pre-wrap break-words">{children}</p>
}

function WordDiffText({ segments }: { segments: WordDiff['segments'] }) {
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

// The settings a row leaves out. A customized default shows them too: folding a rule into its
// built-in's row must not hide its priority, where it applies, or the note its author left.
function DirectiveDetails({ directive, replaces }: { directive: Directive; replaces?: string[] }) {
  const details: Array<[string, string]> = [
    ['Priority', directive.priority == null ? 'Default' : String(directive.priority)],
    ['Applies to', directiveSurfaceSummary(directive.surfaces)],
    ...(replaces && replaces.length > 0 ? [['Replaces', replaces.join(', ')] as [string, string]] : []),
    ...(directive.description ? [['Note', directive.description] as [string, string]] : []),
  ]
  return <QuietSheetDetails details={details} />
}

function AuthoredSheet({ row, actions }: { row: DirectiveRow; actions: DirectiveSheetActions }) {
  const { directive } = row
  // A save in flight (the editor, or a conflict action) resends a directive in full, as does a
  // toggle; starting another from this copy would write a stale value back over it.
  const isBusy = actions.isRowPending(directive.id) || actions.isSaving
  return (
    <QuietSheetFrame
      title={directive.name}
      headerEnd={(
        <Switch
          checked={directive.enabled}
          onCheckedChange={(enabled) => actions.onToggleEnabled(directive, enabled)}
          disabled={isBusy}
          aria-label={`${directive.enabled ? 'Disable' : 'Enable'} ${directive.name}`}
        />
      )}
      footer={(
        <>
          <Button type="button" variant="outline" disabled={isBusy} onClick={() => actions.onEdit(directive)} aria-label={`Edit ${directive.name}`}>
            Edit
          </Button>
          <Button type="button" variant="ghost" className="ml-auto text-destructive hover:text-destructive" disabled={isBusy} onClick={() => actions.onDelete(directive)} aria-label={`Delete ${directive.name}`}>
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
      <QuietSheetField label="When">
        {directive.condition.kind === 'contextual' ? directive.condition.description : 'Always'}
      </QuietSheetField>
      <QuietSheetField label="Instruction"><InstructionText>{directive.action}</InstructionText></QuietSheetField>
      <DirectiveDetails directive={directive} replaces={row.replaces} />
    </QuietSheetFrame>
  )
}

function CustomizedSheet({
  row,
  builtIn,
  actions,
}: {
  row: Extract<DirectiveRow, { kind: 'customized' }>
  builtIn: BuiltInDirective
  actions: DirectiveSheetActions
}) {
  const { directive } = row
  const isBusy = actions.isRowPending(directive.id) || actions.isSaving
  const inUse: VersionInUse = directive.enabled ? 'yours' : 'default'
  const diff = useMemo(() => diffWords(builtIn.action, directive.action), [builtIn.action, directive.action])
  const isComparable = diff.similarity >= WORD_DIFF_SIMILARITY_THRESHOLD
  return (
    <QuietSheetFrame
      title={row.title}
      subtitle={row.title === row.defaultTitle ? 'Radioso default, customized · Always' : `Customizes ${row.defaultTitle} · Always`}
      footer={(
        <>
          <Button type="button" variant="outline" disabled={isBusy} onClick={() => actions.onEdit(directive)}>
            Edit your version
          </Button>
          <Button type="button" variant="ghost" className="ml-auto text-destructive hover:text-destructive" disabled={isBusy} onClick={() => actions.onDelete(directive)}>
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
      <QuietSheetField label="In use">
        {/* Choosing a version flips the customization on or off; its text is kept either way. */}
        <SegmentedControl<VersionInUse>
          aria-label="Version in use"
          value={inUse}
          disabled={isBusy}
          onValueChange={(next) => {
            if (next !== inUse) actions.onToggleEnabled(directive, next === 'yours')
          }}
          options={[
            { value: 'default', label: 'Radioso default' },
            { value: 'yours', label: 'Your version' },
          ]}
        />
      </QuietSheetField>
      {isComparable ? (
        <QuietSheetField label={diff.changes === 0 ? 'Your version · same as the default' : `Your version · ${diff.changes} ${diff.changes === 1 ? 'change' : 'changes'} from the default`}>
          <WordDiffText segments={diff.segments} />
        </QuietSheetField>
      ) : (
        <>
          <QuietSheetField label="Your version"><InstructionText>{directive.action}</InstructionText></QuietSheetField>
          <QuietSheetField label="Radioso default"><InstructionText>{builtIn.action}</InstructionText></QuietSheetField>
        </>
      )}
      <DirectiveDetails directive={directive} />
    </QuietSheetFrame>
  )
}

function DefaultSheet({ entry, actions }: { entry: BuiltInDefaultEntry; actions: DirectiveSheetActions }) {
  const { builtIn, replacedBy } = entry
  const isFullyReplaced = replacedBy?.condition.kind === 'always'
  return (
    <QuietSheetFrame
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
      <QuietSheetField label="Instruction"><InstructionText>{builtIn.action}</InstructionText></QuietSheetField>
    </QuietSheetFrame>
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
  return (
    <QuietDetailSheet
      target={target}
      onClose={onClose}
      returnFocus={(shown) => {
        if (shown.kind === 'default') focusBuiltInRow(shown.entry.builtIn.name)
        else focusDirectiveRow(shown.row.id)
      }}
    >
      {(shown) => <SheetBody target={shown} actions={actions} />}
    </QuietDetailSheet>
  )
}
