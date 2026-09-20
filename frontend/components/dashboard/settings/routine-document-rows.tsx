'use client'

import { useContext, type ReactNode } from 'react'
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, CheckCircle2, CircleDashed, CornerUpRight, GitBranch, ListChecks, Plus, Wrench } from 'lucide-react'

import { findRoutineSkillDescriptor, RoutineSkillCatalogContext } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { Button } from '@/components/ui/button'
import { branchDecisionLabel, branchIsImplicitFallThrough, documentTextToSegments, formatBindingLine, guardToSentence } from '@/lib/routine-document'
import type { RoutineBlockBranch, RoutineBlockDoc, RoutineBlockEnding, RoutineBlockInstructionSegment, RoutineBlockSlot, RoutineBlockStep } from '@/lib/routine-prose'

export const instructionIsEmpty = (segments: RoutineBlockInstructionSegment[]) =>
  segments.every((segment) => segment.kind === 'text' && !segment.text.trim())

// Rows name steps and endings the way the document shows them, so a branch never has to
// fall back to an internal identifier.
export type RoutineDocumentIndex = { stepNumbers: Map<string, number>; endings: Map<string, RoutineBlockEnding> }

export function buildDocumentIndex(doc: RoutineBlockDoc): RoutineDocumentIndex {
  const stepNumbers = new Map(doc.steps.map((step, index) => [step.stableStepId, index + 1]))
  const endings = new Map<string, RoutineBlockEnding>()
  for (const ending of doc.unreferencedEndings) endings.set(ending.stableStepId, ending)
  for (const step of doc.steps) {
    for (const branch of step.branches) {
      if (branch.target.kind === 'ending' && branch.target.ending) endings.set(branch.target.ending.stableStepId, branch.target.ending)
    }
  }
  return { stepNumbers, endings }
}

// A slot reference reads as quiet text with a faint backing, the same "@name" treatment the
// live chip in the instruction editor uses — not a coloured pill — so a row looks the same
// whether or not it happens to be open for editing right now.
function SlotBadge({ slotKey }: { slotKey: string }) {
  return <span className="mx-0.5 rounded-sm bg-muted/50 px-1 py-0 align-baseline text-foreground"><span className="text-muted-foreground">@</span>{slotKey}</span>
}

function InstructionSentence({ segments, editable = false }: { segments: RoutineBlockInstructionSegment[]; editable?: boolean }) {
  if (instructionIsEmpty(segments)) {
    return editable ? <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">Write what this step should do…</p> : null
  }
  // The instruction keeps the line breaks its author wrote, so the row reads them back
  // instead of collapsing every line into one.
  return <p className="whitespace-pre-wrap leading-7 text-foreground">{segments.map((segment, index) => segment.kind === 'text' ? segment.text : <SlotBadge key={`${segment.key}-${index}`} slotKey={segment.key} />)}</p>
}

function InlineSlotText({ text }: { text: string }) {
  return <>{documentTextToSegments(text).map((segment, index) => segment.kind === 'text' ? segment.text : <SlotBadge key={`${segment.key}-${index}`} slotKey={segment.key} />)}</>
}

function DiagnosticNotes({ notes }: { notes?: string[] }) {
  if (!notes || notes.length === 0) return null
  return <div className="mt-1 space-y-0.5">{notes.map((note, index) => <p key={`${note}-${index}`} className="text-xs text-destructive">{note}</p>)}</div>
}

function EditHint({ editable }: { editable: boolean }) {
  return editable ? <span aria-hidden="true" className="ml-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">Edit</span> : null
}

// The routine's own name now lives in the page's title bar, so this row carries only the
// activation summary — what starts the routine, read as a sentence until it is opened for
// editing.
export function RoutineDocumentHeader({ doc, editable = false, onEdit, editor }: {
  doc: RoutineBlockDoc
  editable?: boolean
  onEdit?: () => void
  editor?: ReactNode
}) {
  const trigger = doc.activation.triggerDescription || 'an activation trigger is met'
  return editor ? <div className="rounded-md border border-border bg-muted/30 p-3">{editor}</div> : <button type="button" aria-label="Starts when" onClick={onEdit} disabled={!editable} className="group block text-left disabled:cursor-default"><span className="block text-xs font-semibold text-foreground">Starts when</span><span className="mt-1 block text-sm text-muted-foreground">{trigger}</span><EditHint editable={editable} /></button>
}

export function RoutineInformationSection({ slots, editable = false, editingSlotId, onEditSlot, renderEditor, notesFor }: {
  slots: RoutineBlockSlot[]
  editable?: boolean
  editingSlotId?: string | null
  onEditSlot?: (slot: RoutineBlockSlot) => void
  renderEditor?: (slot: RoutineBlockSlot) => ReactNode
  notesFor?: (slot: RoutineBlockSlot) => string[] | undefined
}) {
  return <section aria-labelledby="routine-document-information" className="space-y-3"><h2 id="routine-document-information" className="text-xl font-semibold tracking-tight text-foreground">Collected information</h2>{slots.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No information is collected.</p> : <ul className="mt-2 space-y-0.5">{slots.map((slot) => <li key={slot.stableSlotId} className={editingSlotId === slot.stableSlotId ? 'rounded-md border border-border bg-muted/30 p-3 text-sm' : 'text-sm'}>{editingSlotId === slot.stableSlotId ? renderEditor?.(slot) : <button type="button" aria-label={slot.key} onClick={() => onEditSlot?.(slot)} disabled={!editable} className="group flex w-full items-baseline gap-2 text-left disabled:cursor-default"><span className="shrink-0 font-medium text-foreground">{slot.key}</span><span className="shrink-0 text-xs text-muted-foreground">{slot.type}{slot.required ? ', required' : ', optional'}</span>{slot.description ? <span className="min-w-0 truncate text-xs text-muted-foreground">{slot.description}</span> : null}<EditHint editable={editable} /></button>}{editingSlotId === slot.stableSlotId ? null : <DiagnosticNotes notes={notesFor?.(slot)} />}</li>)}</ul>}</section>
}

function EndingPhrase({ ending, muted = false }: { ending: RoutineBlockEnding; muted?: boolean }) {
  return <span className={`inline-flex items-baseline gap-1 ${muted ? 'text-muted-foreground' : ''}`}>{ending.kind === 'complete' ? <CheckCircle2 className="h-3.5 w-3.5 self-center" /> : <CornerUpRight className="h-3.5 w-3.5 self-center" />}<span>{ending.kind === 'complete' ? 'Finish' : 'Hand off'}{ending.instruction ? <>: <InlineSlotText text={ending.instruction} /></> : null}</span></span>
}

function BranchTarget({ branch, index }: { branch: RoutineBlockBranch; index?: RoutineDocumentIndex }) {
  if (branch.target.kind === 'step') {
    const number = index?.stepNumbers.get(branch.target.stableStepId)
    return <span>go to {number ? `step ${number}` : branch.target.stableStepId}</span>
  }
  if (branch.target.kind === 'unresolved') {
    // Say what is wrong in the reader's terms. The id is the only clue to what used to be
    // here, so it stays visible for whoever has to pick the replacement.
    return <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"><AlertTriangle className="h-3.5 w-3.5" />goes nowhere — “{branch.target.toRef}” no longer exists</span>
  }
  const ending = branch.target.ending ?? index?.endings.get(branch.target.terminalId)
  if (ending) return <EndingPhrase ending={ending} muted={!branch.target.ending} />
  return <span className="inline-flex items-center gap-1 text-muted-foreground"><CircleDashed className="h-3.5 w-3.5" />the same ending as above</span>
}

// The plain onward path reads as one muted sentence — "then finish: All set." — with none of
// the IF row's icon tile or rail; a default guard is not a decision to draw attention to.
function PlainBranchTarget({ branch, index }: { branch: RoutineBlockBranch; index?: RoutineDocumentIndex }) {
  if (branch.target.kind === 'step') {
    const number = index?.stepNumbers.get(branch.target.stableStepId)
    return <span>go to {number ? `step ${number}` : branch.target.stableStepId}</span>
  }
  if (branch.target.kind === 'unresolved') return <BranchTarget branch={branch} index={index} />
  const ending = branch.target.ending ?? index?.endings.get(branch.target.terminalId)
  if (ending) return <span>{ending.kind === 'complete' ? 'finish' : 'hand off'}{ending.instruction ? <>: <InlineSlotText text={ending.instruction} /></> : null}</span>
  return <span>the same ending as above</span>
}

function RoutineBranchRow({ branch, slotNames, index, editable = false, editing = false, onEdit, editor }: {
  branch: RoutineBlockBranch
  slotNames: Map<string, string>
  index?: RoutineDocumentIndex
  editable?: boolean
  editing?: boolean
  onEdit?: () => void
  editor?: ReactNode
}) {
  // A default guard states no condition, so it reads as the plain onward path rather than a
  // decision — its current semantics carry over unchanged: no icon tile, no "IF", just where
  // the routine goes next.
  const isDefault = branch.guard.kind === 'default'
  if (editing) return <li className="rounded-md border border-border bg-muted/30 p-3 text-sm">{editor}</li>
  if (isDefault) {
    return <li className="py-0.5 text-xs text-muted-foreground"><button type="button" aria-label={branchDecisionLabel(branch.guard.kind)} onClick={onEdit} disabled={!editable} className="group text-left disabled:cursor-default">then <PlainBranchTarget branch={branch} index={index} /><EditHint editable={editable} /></button></li>
  }
  return <li className="py-1"><button type="button" aria-label={branchDecisionLabel(branch.guard.kind)} onClick={onEdit} disabled={!editable} className="group flex w-full flex-wrap items-center gap-2 text-left disabled:cursor-default">
    <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-500/15 text-violet-600 dark:text-violet-400"><GitBranch className="h-3.5 w-3.5" /></span>
    <span aria-hidden="true" className="shrink-0 font-mono text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">If</span>
    <span className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/20 px-2.5 py-1 text-foreground">
      <InlineSlotText text={guardToSentence(branch.guard, slotNames)} />
    </span>
    <BranchTarget branch={branch} index={index} />
    <EditHint editable={editable} />
  </button></li>
}

export function RoutineStepRow({ step, stepIndex, slotNames, index, nextStepId = null, notes, editable = false, editing, onEditInstruction, onEditBinding, onEditApproval, onEditBranch, onAddBranch, onEditStep, onMoveStepUp, onMoveStepDown, canMoveStepUp = false, canMoveStepDown = false, instructionEditor, bindingEditor, approvalEditor, branchEditor, stepEditor, insertStepAfter }: {
  step: RoutineBlockStep
  stepIndex: number
  slotNames: Map<string, string>
  index?: RoutineDocumentIndex
  nextStepId?: string | null
  notes?: string[]
  editable?: boolean
  editing?: string | null
  onEditInstruction?: () => void
  onEditBinding?: () => void
  onEditApproval?: () => void
  onEditBranch?: (index: number) => void
  // Appends a new branch under this step and opens it for editing — the round "+" at the
  // foot of the branch rail. Omitted for a step kind (approval) that owns its branches
  // structurally instead.
  onAddBranch?: () => void
  onEditStep?: () => void
  onMoveStepUp?: () => void
  onMoveStepDown?: () => void
  canMoveStepUp?: boolean
  canMoveStepDown?: boolean
  instructionEditor?: ReactNode
  bindingEditor?: ReactNode
  approvalEditor?: ReactNode
  branchEditor?: (index: number, branch: RoutineBlockBranch) => ReactNode
  stepEditor?: ReactNode
  // Rendered as a hover/focus-revealed overlay pinned to this row's bottom edge, so an author
  // can insert a step between two rows without first appending one at the end and moving it
  // up. Built by the container, which owns `apply` and the step-kind choices — this row only
  // places it.
  insertStepAfter?: ReactNode
}) {
  const catalog = useContext(RoutineSkillCatalogContext)
  const ref = step.kind === 'tool' ? step.toolRef : step.kind === 'action' ? step.actionType : null
  const descriptor = ref ? findRoutineSkillDescriptor(catalog.skills, ref, ref) : undefined
  const label = step.kind === 'approval' ? 'Approval' : descriptor?.displayName ?? ref ?? 'Chat'
  // Chat is what a step is unless it is something else, so only the other kinds announce
  // themselves, as a small muted badge after the sentence rather than a heading of their own.
  const isChat = step.kind === 'chat'
  // A bare numeral gutter, not a badge — the row itself carries no card chrome until it is
  // opened for editing. A chat step's numeral doubles as its "open the step editor" control,
  // the same affordance the kind badge gives every other step kind.
  const numeralClassName = 'w-6 shrink-0 pt-0.5 text-right font-mono text-xs text-muted-foreground'
  const number = isChat
    ? <button type="button" aria-label={label} onClick={onEditStep} disabled={!editable} className={`${numeralClassName} transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground`}>{stepIndex + 1}.</button>
    : <span aria-hidden="true" className={numeralClassName}>{stepIndex + 1}.</span>
  // Reorder is a hover/focus affordance, not a permanent fixture in the gutter — pinned to the
  // left of the numeral by absolute position so its own height never widens the row at rest.
  const moveControls = editable && (onMoveStepUp || onMoveStepDown) ? <div className="pointer-events-none absolute right-full top-0 mr-0.5 opacity-0 transition-opacity group-hover/insertafter:opacity-100 group-focus-within/insertafter:opacity-100">
    <div className="pointer-events-auto flex flex-col">
      <button type="button" aria-label={`Move step ${stepIndex + 1} up`} onClick={onMoveStepUp} disabled={!canMoveStepUp} className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"><ArrowUp className="h-3 w-3" /></button>
      <button type="button" aria-label={`Move step ${stepIndex + 1} down`} onClick={onMoveStepDown} disabled={!canMoveStepDown} className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"><ArrowDown className="h-3 w-3" /></button>
    </div>
  </div> : null
  // Pinned under the numeral gutter and revealed on hover/focus (or always, on touch) — a
  // quiet "+" between two lines rather than a control spanning the row's full width.
  const insertAfterOverlay = insertStepAfter ? <div className="pointer-events-none absolute inset-x-0 -bottom-2.5 z-10 flex justify-center opacity-0 transition-opacity group-hover/insertafter:opacity-100 group-focus-within/insertafter:opacity-100 [@media(hover:none)]:opacity-100"><div className="pointer-events-auto">{insertStepAfter}</div></div> : null
  // No card chrome while editing — the editor's own faint focus ring is the only thing that
  // marks it as active, matching the bare-sentence read state either side of it.
  const instruction = editing === 'instruction'
    ? <div className="min-w-0 flex-1">{instructionEditor}</div>
    : <button type="button" aria-label="Instruction" onClick={onEditInstruction} disabled={!editable} className="group block min-w-0 flex-1 text-left disabled:cursor-default"><InstructionSentence segments={step.instruction} editable={editable} /><EditHint editable={editable} /></button>
  // The skill or approval identity reads as a chip inline with the sentence — the same visual
  // language as a variable chip — rather than a right-aligned pill announcing the row's kind.
  // It is still the same "open the step editor" control non-chat kinds have always had.
  const kindBadge = !isChat ? <button type="button" aria-label={label} onClick={onEditStep} disabled={!editable} className="group mr-1.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-sky-300 bg-sky-100 px-1.5 py-0 align-baseline text-xs font-medium text-sky-900 disabled:cursor-default">{step.kind === 'approval' ? <ListChecks className="h-3 w-3" /> : <Wrench className="h-3 w-3" />}{label}</button> : null
  const plainBranchRows: ReactNode[] = []
  const railBranchRows: ReactNode[] = []
  let anyBranchEditing = false
  step.branches.forEach((branch, branchIndex) => {
    const editingBranch = editing === `branch:${branchIndex}`
    if (editingBranch) anyBranchEditing = true
    if (!editingBranch && branchIsImplicitFallThrough(branch, nextStepId)) {
      if (!editable || editing !== 'step') return
      plainBranchRows.push(<li key={`${step.stableStepId}-${branchIndex}`} className="py-0.5 text-xs text-muted-foreground"><button type="button" aria-label="Continue to the next step" onClick={() => onEditBranch?.(branchIndex)} className="group text-left">then continue to the next step<EditHint editable={editable} /></button></li>)
      return
    }
    const row = <RoutineBranchRow key={`${step.stableStepId}-${branchIndex}`} branch={branch} slotNames={slotNames} index={index} editable={editable} editing={editingBranch} onEdit={() => onEditBranch?.(branchIndex)} editor={branchEditor?.(branchIndex, branch)} />
    if (!editingBranch && branch.guard.kind === 'default') plainBranchRows.push(row)
    else railBranchRows.push(row)
  })
  // A branch is content — the IF tile, condition, and target always read, at rest — but the
  // thin rail connecting them and the round "+" that adds another are chrome, revealed on
  // hover/focus of the step (or kept up unprompted while a branch inside is being edited) and
  // absolutely positioned so neither reserves height the always-visible branches don't need.
  const railHiddenUntilActive = !anyBranchEditing
  const railHoverClass = railHiddenUntilActive ? ' opacity-0 transition-opacity group-hover/insertafter:opacity-100 group-focus-within/insertafter:opacity-100' : ''
  const branchRail = railBranchRows.length > 0 ? <div className="relative mt-1 pl-4">
    <div aria-hidden="true" className={`pointer-events-none absolute inset-y-0 left-0 border-l border-border${railHoverClass}`} />
    <ul className="space-y-0.5">{railBranchRows}</ul>
    {editable && onAddBranch ? <div className={`pointer-events-none absolute -bottom-2.5 left-0 -translate-x-1/2${railHoverClass}`}><button type="button" aria-label={`Add a branch to step ${stepIndex + 1}`} onClick={onAddBranch} className="pointer-events-auto flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground hover:border-primary hover:text-primary"><Plus className="h-3 w-3" /></button></div> : null}
  </div> : null
  const details = <>
    {step.kind === 'tool' || step.kind === 'action' ? (
      editing === 'binding'
        ? <div className="mt-2"><div className="rounded-md border border-border bg-muted/30 p-3">{bindingEditor}</div></div>
        // A CSS grid row collapsed to `0fr` takes no space at rest and expands to its natural
        // height on hover/focus, so this line reserves nothing when it isn't shown — unlike an
        // opacity fade, which keeps the element's layout box (and the gap it leaves) at rest.
        : <div className="grid grid-rows-[0fr] transition-[grid-template-rows] group-hover/insertafter:grid-rows-[1fr] group-focus-within/insertafter:grid-rows-[1fr]"><div className="overflow-hidden"><button type="button" aria-label="Bindings" onClick={onEditBinding} disabled={!editable} className="group mt-1 flex items-center gap-1 text-left text-xs text-muted-foreground disabled:cursor-default"><ArrowRight className="h-3.5 w-3.5" />{formatBindingLine(step.inputBindings, step.outputAssignments) ?? 'uses nothing → sets nothing'}<EditHint editable={editable} /></button></div></div>
    ) : null}
    {step.kind === 'approval' ? <div className="mt-2">{editing === 'approval' ? <div className="rounded-md border border-border bg-muted/30 p-3">{approvalEditor}</div> : <button type="button" aria-label="Approval choices" onClick={onEditApproval} disabled={!editable} className="group block w-full text-left text-sm disabled:cursor-default"><p className="font-medium">A person chooses:<EditHint editable={editable} /></p><ul className="mt-2 space-y-1">{(step.options ?? []).map((option) => <li key={option.id}>{option.label}{option.description ? ` — ${option.description}` : ''}</li>)}</ul></button>}</div> : null}
    {plainBranchRows.length > 0 ? <ul className="mt-1">{plainBranchRows}</ul> : null}
    {branchRail}
    {editing ? null : <DiagnosticNotes notes={notes} />}
  </>
  return <li className="group/insertafter relative rounded-md px-2 py-1.5 transition-colors first:mt-0 hover:bg-muted/40">
    <div className="flex items-start gap-3">
      <div className="relative flex shrink-0 items-start gap-1">
        {moveControls}
        {number}
      </div>
      <div className="min-w-0 flex-1">
        {/* The kind badge is also this row's "open the step editor" control (its aria-label
            is the step's name), so it stays mounted in both states — only the sentence beside
            it gives way to the editor panel. */}
        <div className="flex flex-wrap items-baseline">
          {kindBadge}
          {editing === 'step' ? null : instruction}
        </div>
        {editing === 'step' ? <div className="mt-2 rounded-md border border-border bg-muted/30 p-3">{stepEditor}</div> : null}
        {details}
      </div>
    </div>
    {insertAfterOverlay}
  </li>
}

export function RoutineEndingsSection({ endings, editable = false, editingEndingId, onEdit, onAdd, renderEditor, notesFor }: {
  endings: RoutineBlockEnding[]
  editable?: boolean
  editingEndingId?: string | null
  onEdit?: (ending: RoutineBlockEnding) => void
  onAdd?: (kind: RoutineBlockEnding['kind']) => void
  renderEditor?: (ending: RoutineBlockEnding) => ReactNode
  notesFor?: (ending: RoutineBlockEnding) => string[] | undefined
}) {
  // An author with no spare endings still needs somewhere to add one, so the section shows
  // its heading and controls even when the list is empty.
  if (endings.length === 0 && !editable) return null
  return <section aria-labelledby="routine-document-endings" className="space-y-3"><div className="flex items-center justify-between"><h2 id="routine-document-endings" className="text-xl font-semibold tracking-tight text-foreground">Endings</h2>{editable && onAdd ? <div className="flex gap-1"><Button type="button" size="sm" variant="ghost" onClick={() => onAdd('complete')}>Add finish</Button><Button type="button" size="sm" variant="ghost" onClick={() => onAdd('handoff')}>Add hand-off</Button></div> : null}</div><ul className="mt-2 divide-y divide-border">{endings.map((ending) => <li key={ending.stableStepId} className={editingEndingId === ending.stableStepId ? 'rounded-md border border-border bg-muted/30 p-3 text-sm' : 'py-3 text-sm'}>{editingEndingId === ending.stableStepId ? renderEditor?.(ending) : <button type="button" aria-label={`${ending.kind === 'complete' ? 'Finish' : 'Hand-off'} ending`} onClick={() => onEdit?.(ending)} disabled={!editable} className="group flex w-full items-center gap-2 text-left disabled:cursor-default"><EndingPhrase ending={ending} /><EditHint editable={editable} /></button>}{editingEndingId === ending.stableStepId ? null : <DiagnosticNotes notes={notesFor?.(ending)} />}</li>)}</ul></section>
}
