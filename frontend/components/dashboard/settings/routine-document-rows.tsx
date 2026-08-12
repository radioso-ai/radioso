'use client'

import { useContext, type ReactNode } from 'react'
import { ArrowRight, Bot, CheckCircle2, CircleDashed, CornerUpRight, GitBranch, ListChecks, Wrench } from 'lucide-react'

import { findRoutineSkillDescriptor, RoutineSkillCatalogContext } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { Badge } from '@/components/ui/badge'
import { documentTextToSegments, formatBindingLine, guardToSentence } from '@/lib/routine-document'
import type { RoutineBlockBranch, RoutineBlockDoc, RoutineBlockEnding, RoutineBlockInstructionSegment, RoutineBlockSlot, RoutineBlockStep } from '@/lib/routine-prose'

export const instructionIsEmpty = (segments: RoutineBlockInstructionSegment[]) =>
  segments.every((segment) => segment.kind === 'text' && !segment.text.trim())

export function InstructionSentence({ segments, editable = false }: { segments: RoutineBlockInstructionSegment[]; editable?: boolean }) {
  if (instructionIsEmpty(segments)) {
    return editable ? <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">Write what this step should do…</p> : null
  }
  return <p className="leading-7 text-foreground">{segments.map((segment, index) => segment.kind === 'text' ? segment.text : <span key={`${segment.key}-${index}`} className="mx-0.5 inline-flex select-none items-center rounded-md border border-emerald-300 bg-emerald-100 px-1.5 py-0 align-baseline text-xs font-medium text-emerald-900">{segment.key}</span>)}</p>
}

function InlineSlotText({ text }: { text: string }) {
  return <>{documentTextToSegments(text).map((segment, index) => segment.kind === 'text' ? segment.text : <span key={`${segment.key}-${index}`} className="mx-0.5 inline-flex select-none items-center rounded-md border border-emerald-300 bg-emerald-100 px-1.5 py-0 align-baseline text-xs font-medium text-emerald-900">{segment.key}</span>)}</>
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

export function RoutineInformationSection({ slots, editable = false, editingSlotId, onEditSlot, renderEditor }: {
  slots: RoutineBlockSlot[]
  editable?: boolean
  editingSlotId?: string | null
  onEditSlot?: (slot: RoutineBlockSlot) => void
  renderEditor?: (slot: RoutineBlockSlot) => ReactNode
}) {
  return <section aria-labelledby="routine-document-information"><h3 id="routine-document-information" className="text-sm font-semibold text-foreground">Collected information</h3>{slots.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No information is collected.</p> : <ul className="mt-2 divide-y divide-border">{slots.map((slot) => <li key={slot.stableSlotId} className={editingSlotId === slot.stableSlotId ? 'rounded-md border border-border bg-muted/30 p-3 text-sm' : 'py-2 text-sm'}>{editingSlotId === slot.stableSlotId ? renderEditor?.(slot) : <button type="button" aria-label={slot.key} onClick={() => onEditSlot?.(slot)} disabled={!editable} className="group flex w-full flex-wrap items-baseline gap-x-2 gap-y-1 text-left disabled:cursor-default"><span className="font-medium text-foreground">{slot.key}</span><Badge variant="outline" className="font-normal">{slot.type}</Badge><span className={slot.required ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}>{slot.required ? 'required' : 'optional'}</span><EditHint editable={editable} />{slot.description ? <span className="basis-full text-muted-foreground">{slot.description}</span> : null}</button>}</li>)}</ul>}</section>
}

function BranchTarget({ branch }: { branch: RoutineBlockBranch }) {
  if (branch.target.kind === 'step') return <span>continue to {branch.target.stableStepId}</span>
  if (branch.target.ending) return <span className="inline-flex items-center gap-1">{branch.target.ending.kind === 'complete' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <CornerUpRight className="h-3.5 w-3.5" />}{branch.target.ending.kind === 'complete' ? 'finish' : 'hand off'}{branch.target.ending.instruction ? <><span>:</span><InlineSlotText text={branch.target.ending.instruction} /></> : null}</span>
  return <span className="inline-flex items-center gap-1 text-muted-foreground"><CircleDashed className="h-3.5 w-3.5" />see {branch.target.terminalId} ending</span>
}

export function RoutineBranchRow({ branch, slotNames, editable = false, editing = false, onEdit, editor }: {
  branch: RoutineBlockBranch
  slotNames: Map<string, string>
  editable?: boolean
  editing?: boolean
  onEdit?: () => void
  editor?: ReactNode
}) {
  const branchIsAi = branch.guard.provenance === 'judgment'
  if (editing) return <li className="rounded-md border border-border bg-muted/30 p-3 text-sm">{editor}</li>
  return <li className="py-2 text-sm"><button type="button" aria-label={branchIsAi ? 'AI decides' : 'Rule'} onClick={onEdit} disabled={!editable} className="group flex w-full flex-wrap items-center gap-2 text-left disabled:cursor-default"><Badge variant="outline" className="border-border bg-transparent font-normal text-muted-foreground">{branchIsAi ? 'AI decides' : 'Rule'}</Badge><span><InlineSlotText text={guardToSentence(branch.guard, slotNames)} /></span><GitBranch className="h-3.5 w-3.5 text-muted-foreground" /><BranchTarget branch={branch} /><EditHint editable={editable} /></button></li>
}

export function RoutineStepRow({ step, stepIndex, slotNames, editable = false, editing, onEditInstruction, onEditBinding, onEditApproval, onEditBranch, onEditStep, instructionEditor, bindingEditor, approvalEditor, branchEditor, stepEditor }: {
  step: RoutineBlockStep
  stepIndex: number
  slotNames: Map<string, string>
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
  return <li className="py-5 first:pt-0 last:pb-0"><div className="flex items-center gap-2 text-sm font-medium text-foreground"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs">{stepIndex + 1}</span>{step.kind === 'approval' ? <ListChecks className="h-4 w-4" /> : step.kind === 'tool' || step.kind === 'action' ? <Wrench className="h-4 w-4" /> : <Bot className="h-4 w-4" />}<button type="button" aria-label={label} onClick={onEditStep} disabled={!editable} className="group text-left disabled:cursor-default"><span>{label}</span><EditHint editable={editable} /></button></div>{editing === 'step' ? <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">{stepEditor}</div> : <div className="mt-3">{editing === 'instruction' ? <div className="rounded-md border border-border bg-muted/30 p-3">{instructionEditor}</div> : <button type="button" aria-label="Instruction" onClick={onEditInstruction} disabled={!editable} className="group block w-full text-left disabled:cursor-default"><InstructionSentence segments={step.instruction} /><EditHint editable={editable} /></button>}</div>}{step.kind === 'tool' || step.kind === 'action' ? <div className="mt-3">{editing === 'binding' ? <div className="rounded-md border border-border bg-muted/30 p-3">{bindingEditor}</div> : <button type="button" aria-label="Bindings" onClick={onEditBinding} disabled={!editable} className="group flex items-center gap-1 text-left text-xs text-muted-foreground disabled:cursor-default"><ArrowRight className="h-3.5 w-3.5" />{formatBindingLine(step.inputBindings, step.outputAssignments) ?? 'uses nothing → sets nothing'}<EditHint editable={editable} /></button>}</div> : null}{step.kind === 'approval' ? <div className="mt-3">{editing === 'approval' ? <div className="rounded-md border border-border bg-muted/30 p-3">{approvalEditor}</div> : <button type="button" aria-label="Approval choices" onClick={onEditApproval} disabled={!editable} className="group block w-full text-left text-sm disabled:cursor-default"><p className="font-medium">A person chooses:<EditHint editable={editable} /></p><ul className="mt-2 space-y-1">{(step.options ?? []).map((option) => <li key={option.id}>{option.label}{option.description ? ` — ${option.description}` : ''}</li>)}</ul></button>}</div> : null}{step.branches.length > 0 ? <ul className="mt-4 border-l border-border pl-3">{step.branches.map((branch, index) => <RoutineBranchRow key={`${step.stableStepId}-${index}`} branch={branch} slotNames={slotNames} editable={editable} editing={editing === `branch:${index}`} onEdit={() => onEditBranch?.(index)} editor={branchEditor?.(index, branch)} />)}</ul> : null}</li>
}

export function RoutineEndingsSection({ endings, editable = false, editingEndingId, onEdit, renderEditor }: {
  endings: RoutineBlockEnding[]
  editable?: boolean
  editingEndingId?: string | null
  onEdit?: (ending: RoutineBlockEnding) => void
  renderEditor?: (ending: RoutineBlockEnding) => ReactNode
}) {
  if (endings.length === 0) return null
  return <section aria-labelledby="routine-document-endings"><h3 id="routine-document-endings" className="text-sm font-semibold text-foreground">Endings</h3><ul className="mt-2 divide-y divide-border">{endings.map((ending) => <li key={ending.stableStepId} className={editingEndingId === ending.stableStepId ? 'rounded-md border border-border bg-muted/30 p-3 text-sm' : 'py-3 text-sm'}>{editingEndingId === ending.stableStepId ? renderEditor?.(ending) : <button type="button" aria-label={`${ending.kind === 'complete' ? 'Finish' : 'Hand-off'} ending`} onClick={() => onEdit?.(ending)} disabled={!editable} className="group flex w-full items-center gap-2 text-left disabled:cursor-default">{ending.kind === 'complete' ? <CheckCircle2 className="h-4 w-4" /> : <CornerUpRight className="h-4 w-4" />}<span className="inline-flex items-center gap-1">{ending.kind === 'complete' ? 'Finish' : 'Hand off'}{ending.instruction ? <><span>:</span><InlineSlotText text={ending.instruction} /></> : null}</span><EditHint editable={editable} /></button>}</li>)}</ul></section>
}
