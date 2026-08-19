'use client'

import { useContext, type ReactNode } from 'react'
import { ArrowRight, CheckCircle2, CircleDashed, CornerUpRight, GitBranch, ListChecks, Wrench } from 'lucide-react'

import { findRoutineSkillDescriptor, RoutineSkillCatalogContext } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { Badge } from '@/components/ui/badge'
import { branchIsImplicitFallThrough, documentTextToSegments, formatBindingLine, guardToSentence } from '@/lib/routine-document'
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

export function InstructionSentence({ segments, editable = false }: { segments: RoutineBlockInstructionSegment[]; editable?: boolean }) {
  if (instructionIsEmpty(segments)) {
    return editable ? <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">Write what this step should do…</p> : null
  }
  return <p className="leading-7 text-foreground">{segments.map((segment, index) => segment.kind === 'text' ? segment.text : <span key={`${segment.key}-${index}`} className="mx-0.5 inline-flex select-none items-center rounded-md border border-emerald-300 bg-emerald-100 px-1.5 py-0 align-baseline text-xs font-medium text-emerald-900">{segment.key}</span>)}</p>
}

function InlineSlotText({ text }: { text: string }) {
  return <>{documentTextToSegments(text).map((segment, index) => segment.kind === 'text' ? segment.text : <span key={`${segment.key}-${index}`} className="mx-0.5 inline-flex select-none items-center rounded-md border border-emerald-300 bg-emerald-100 px-1.5 py-0 align-baseline text-xs font-medium text-emerald-900">{segment.key}</span>)}</>
}

export function DiagnosticNotes({ notes }: { notes?: string[] }) {
  if (!notes || notes.length === 0) return null
  return <div className="mt-1 space-y-0.5">{notes.map((note, index) => <p key={`${note}-${index}`} className="text-xs text-destructive">{note}</p>)}</div>
}

function EditHint({ editable }: { editable: boolean }) {
  return editable ? <span aria-hidden="true" className="ml-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">Edit</span> : null
}

export function RoutineDocumentHeader({ doc, editable = false, onEdit, editor }: {
  doc: RoutineBlockDoc
  editable?: boolean
  onEdit?: () => void
  editor?: ReactNode
}) {
  const trigger = doc.activation.triggerDescription || 'an activation trigger is met'
  return <header className="border-b border-border pb-4"><h2 className="text-xl font-semibold tracking-tight text-foreground">{doc.name || 'Untitled routine'}</h2>{editor ? <div className="rounded-md border border-border bg-muted/30 p-3">{editor}</div> : <button type="button" aria-label="Starts when" onClick={onEdit} disabled={!editable} className="group mt-3 block text-left disabled:cursor-default"><span className="block text-xs font-semibold text-foreground">Starts when</span><span className="mt-1 block text-sm text-muted-foreground">{trigger}</span><EditHint editable={editable} /></button>}</header>
}

export function RoutineInformationSection({ slots, editable = false, editingSlotId, onEditSlot, renderEditor, notesFor }: {
  slots: RoutineBlockSlot[]
  editable?: boolean
  editingSlotId?: string | null
  onEditSlot?: (slot: RoutineBlockSlot) => void
  renderEditor?: (slot: RoutineBlockSlot) => ReactNode
  notesFor?: (slot: RoutineBlockSlot) => string[] | undefined
}) {
  return <section aria-labelledby="routine-document-information"><h3 id="routine-document-information" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Collected information</h3>{slots.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No information is collected.</p> : <ul className="mt-2 space-y-0.5">{slots.map((slot) => <li key={slot.stableSlotId} className={editingSlotId === slot.stableSlotId ? 'rounded-md border border-border bg-muted/30 p-3 text-sm' : 'text-sm'}>{editingSlotId === slot.stableSlotId ? renderEditor?.(slot) : <button type="button" aria-label={slot.key} onClick={() => onEditSlot?.(slot)} disabled={!editable} className="group flex w-full items-baseline gap-2 text-left disabled:cursor-default"><span className="shrink-0 font-medium text-foreground">{slot.key}</span><span className="shrink-0 text-xs text-muted-foreground">{slot.type}{slot.required ? ', required' : ', optional'}</span>{slot.description ? <span className="min-w-0 truncate text-xs text-muted-foreground">{slot.description}</span> : null}<EditHint editable={editable} /></button>}{editingSlotId === slot.stableSlotId ? null : <DiagnosticNotes notes={notesFor?.(slot)} />}</li>)}</ul>}</section>
}

function EndingPhrase({ ending, muted = false }: { ending: RoutineBlockEnding; muted?: boolean }) {
  return <span className={`inline-flex items-baseline gap-1 ${muted ? 'text-muted-foreground' : ''}`}>{ending.kind === 'complete' ? <CheckCircle2 className="h-3.5 w-3.5 self-center" /> : <CornerUpRight className="h-3.5 w-3.5 self-center" />}<span>{ending.kind === 'complete' ? 'Finish' : 'Hand off'}{ending.instruction ? <>: <InlineSlotText text={ending.instruction} /></> : null}</span></span>
}

function BranchTarget({ branch, index }: { branch: RoutineBlockBranch; index?: RoutineDocumentIndex }) {
  if (branch.target.kind === 'step') {
    const number = index?.stepNumbers.get(branch.target.stableStepId)
    return <span>go to {number ? `step ${number}` : branch.target.stableStepId}</span>
  }
  const ending = branch.target.ending ?? index?.endings.get(branch.target.terminalId)
  if (ending) return <EndingPhrase ending={ending} muted={!branch.target.ending} />
  return <span className="inline-flex items-center gap-1 text-muted-foreground"><CircleDashed className="h-3.5 w-3.5" />the same ending as above</span>
}

export function RoutineBranchRow({ branch, slotNames, index, editable = false, editing = false, onEdit, editor }: {
  branch: RoutineBlockBranch
  slotNames: Map<string, string>
  index?: RoutineDocumentIndex
  editable?: boolean
  editing?: boolean
  onEdit?: () => void
  editor?: ReactNode
}) {
  const branchIsAi = branch.guard.provenance === 'judgment'
  // A default guard states no condition, so it reads as the plain onward path rather than a
  // decision: no badge, no "otherwise", just where the routine goes.
  const isDefault = branch.guard.kind === 'default'
  if (editing) return <li className="rounded-md border border-border bg-muted/30 p-3 text-sm">{editor}</li>
  return <li className="py-1.5 text-sm"><button type="button" aria-label={isDefault ? 'Continue' : branchIsAi ? 'AI decides' : 'Rule'} onClick={onEdit} disabled={!editable} className="group flex w-full flex-wrap items-center gap-2 text-left disabled:cursor-default">{isDefault ? <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /> : <><Badge variant="outline" className="border-border bg-transparent font-normal text-muted-foreground">{branchIsAi ? 'AI decides' : 'Rule'}</Badge><span><InlineSlotText text={guardToSentence(branch.guard, slotNames)} /></span><GitBranch className="h-3.5 w-3.5 text-muted-foreground" /></>}<BranchTarget branch={branch} index={index} /><EditHint editable={editable} /></button></li>
}

export function RoutineStepRow({ step, stepIndex, slotNames, index, nextStepId = null, notes, editable = false, editing, onEditInstruction, onEditBinding, onEditApproval, onEditBranch, onEditStep, instructionEditor, bindingEditor, approvalEditor, branchEditor, stepEditor }: {
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
  onEditStep?: () => void
  instructionEditor?: ReactNode
  bindingEditor?: ReactNode
  approvalEditor?: ReactNode
  branchEditor?: (index: number, branch: RoutineBlockBranch) => ReactNode
  stepEditor?: ReactNode
}) {
  const catalog = useContext(RoutineSkillCatalogContext)
  const ref = step.kind === 'tool' ? step.toolRef : step.kind === 'action' ? step.actionType : null
  const descriptor = ref ? findRoutineSkillDescriptor(catalog.skills, ref, ref) : undefined
  const label = step.kind === 'approval' ? 'Approval' : descriptor?.displayName ?? ref ?? 'Chat'
  // Chat is what a step is unless it is something else, so only the other kinds announce
  // themselves; a chat step is just its number and its sentence.
  const isChat = step.kind === 'chat'
  const number = <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{stepIndex + 1}</span>
  const instruction = editing === 'instruction'
    ? <div className="rounded-md border border-border bg-muted/30 p-3">{instructionEditor}</div>
    : <button type="button" aria-label="Instruction" onClick={onEditInstruction} disabled={!editable} className="group block w-full text-left disabled:cursor-default"><InstructionSentence segments={step.instruction} editable={editable} /><EditHint editable={editable} /></button>
  const branchRows = step.branches.map((branch, branchIndex) => {
    const editingBranch = editing === `branch:${branchIndex}`
    if (!editingBranch && branchIsImplicitFallThrough(branch, nextStepId)) {
      if (!editable || editing !== 'step') return null
      return <li key={`${step.stableStepId}-${branchIndex}`} className="py-1.5 text-xs text-muted-foreground"><button type="button" aria-label="Continue to the next step" onClick={() => onEditBranch?.(branchIndex)} className="group text-left">then continue to the next step<EditHint editable={editable} /></button></li>
    }
    return <RoutineBranchRow key={`${step.stableStepId}-${branchIndex}`} branch={branch} slotNames={slotNames} index={index} editable={editable} editing={editingBranch} onEdit={() => onEditBranch?.(branchIndex)} editor={branchEditor?.(branchIndex, branch)} />
  }).filter(Boolean)
  const details = <>
    {step.kind === 'tool' || step.kind === 'action' ? <div className="mt-2">{editing === 'binding' ? <div className="rounded-md border border-border bg-muted/30 p-3">{bindingEditor}</div> : <button type="button" aria-label="Bindings" onClick={onEditBinding} disabled={!editable} className="group flex items-center gap-1 text-left text-xs text-muted-foreground disabled:cursor-default"><ArrowRight className="h-3.5 w-3.5" />{formatBindingLine(step.inputBindings, step.outputAssignments) ?? 'uses nothing → sets nothing'}<EditHint editable={editable} /></button>}</div> : null}
    {step.kind === 'approval' ? <div className="mt-2">{editing === 'approval' ? <div className="rounded-md border border-border bg-muted/30 p-3">{approvalEditor}</div> : <button type="button" aria-label="Approval choices" onClick={onEditApproval} disabled={!editable} className="group block w-full text-left text-sm disabled:cursor-default"><p className="font-medium">A person chooses:<EditHint editable={editable} /></p><ul className="mt-2 space-y-1">{(step.options ?? []).map((option) => <li key={option.id}>{option.label}{option.description ? ` — ${option.description}` : ''}</li>)}</ul></button>}</div> : null}
    {branchRows.length > 0 ? <ul className="mt-2">{branchRows}</ul> : null}
    {editing ? null : <DiagnosticNotes notes={notes} />}
  </>
  if (isChat) {
    return <li className="py-3 first:pt-0 last:pb-0"><div className="flex items-start gap-3"><button type="button" aria-label={label} onClick={onEditStep} disabled={!editable} className="group mt-0.5 disabled:cursor-default">{number}</button><div className="min-w-0 flex-1">{editing === 'step' ? <div className="rounded-md border border-border bg-muted/30 p-3">{stepEditor}</div> : instruction}{details}</div></div></li>
  }
  return <li className="py-3 first:pt-0 last:pb-0"><div className="flex items-start gap-3">{number}<div className="min-w-0 flex-1"><div className="flex items-center gap-2 text-sm font-medium text-foreground">{step.kind === 'approval' ? <ListChecks className="h-4 w-4" /> : <Wrench className="h-4 w-4" />}<button type="button" aria-label={label} onClick={onEditStep} disabled={!editable} className="group text-left disabled:cursor-default"><span>{label}</span><EditHint editable={editable} /></button></div>{editing === 'step' ? <div className="mt-2 rounded-md border border-border bg-muted/30 p-3">{stepEditor}</div> : <div className="mt-1">{instruction}</div>}{details}</div></div></li>
}

export function RoutineEndingsSection({ endings, editable = false, editingEndingId, onEdit, renderEditor, notesFor }: {
  endings: RoutineBlockEnding[]
  editable?: boolean
  editingEndingId?: string | null
  onEdit?: (ending: RoutineBlockEnding) => void
  renderEditor?: (ending: RoutineBlockEnding) => ReactNode
  notesFor?: (ending: RoutineBlockEnding) => string[] | undefined
}) {
  if (endings.length === 0) return null
  return <section aria-labelledby="routine-document-endings"><h3 id="routine-document-endings" className="text-sm font-semibold text-foreground">Endings</h3><ul className="mt-2 divide-y divide-border">{endings.map((ending) => <li key={ending.stableStepId} className={editingEndingId === ending.stableStepId ? 'rounded-md border border-border bg-muted/30 p-3 text-sm' : 'py-3 text-sm'}>{editingEndingId === ending.stableStepId ? renderEditor?.(ending) : <button type="button" aria-label={`${ending.kind === 'complete' ? 'Finish' : 'Hand-off'} ending`} onClick={() => onEdit?.(ending)} disabled={!editable} className="group flex w-full items-center gap-2 text-left disabled:cursor-default"><EndingPhrase ending={ending} /><EditHint editable={editable} /></button>}{editingEndingId === ending.stableStepId ? null : <DiagnosticNotes notes={notesFor?.(ending)} />}</li>)}</ul></section>
}
