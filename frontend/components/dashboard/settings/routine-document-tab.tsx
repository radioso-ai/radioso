'use client'

import { useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'

import { RoutineInstructionEditor, type RoutineEditorVariable } from '@/components/dashboard/settings/routine-chip-editor'
import { buildDocumentIndex, instructionIsEmpty, RoutineDocumentHeader, RoutineEndingsSection, RoutineInformationSection, RoutineStepRow, type RoutineDocumentIndex } from '@/components/dashboard/settings/routine-document-rows'
import { findRoutineSkillDescriptor, RoutineSkillCatalogContext, RoutineSkillCatalogPopover } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { RoutineDefinitionDraft, RoutineFieldGuardOp, RoutineFieldGuardUnit, RoutineGuardKind, RoutineReentryMode, RoutineSlotType } from '@/lib/api'
import { formatBindingLine, formatBranchTargetLabel } from '@/lib/routine-document'
import {
  addBranch,
  addStep,
  changeBranchGuardKind,
  createEndingForBranch,
  moveStep,
  referenceEnding,
  removeBranch,
  removeSlot,
  removeStep,
  renameSlot,
  replaceInstruction,
  slotReferences,
  targetBranchAtStep,
  updateActivation,
  updateApproval,
  updateBindings,
  updateBranchGuard,
  updateEnding,
  updateSlot,
  updateStep,
} from '@/lib/routine-document-edits'
import { draftFromBlockDoc, fieldGuardOpNeedsUnit, fieldGuardOpNeedsValue, ROUTINE_FIELD_GUARD_UNITS, routineToBlockDoc, slugifyVariableKey, type ProseParagraph, type ProseSegment, type RoutineBlockBranch, type RoutineBlockDoc, type RoutineBlockEnding, type RoutineBlockGuard, type RoutineBlockInstructionSegment, type RoutineBlockStep, type RoutineInputBinding } from '@/lib/routine-prose'

const slotTypes: RoutineSlotType[] = ['text', 'number', 'boolean', 'email', 'date']
const guardKinds: RoutineGuardKind[] = ['field', 'slot_filled', 'outcome', 'counter', 'default']
const branchEnding = (branch: RoutineBlockBranch) => branch.target.kind === 'ending' ? branch.target.ending : undefined

const instructionParagraph = (segments: RoutineBlockInstructionSegment[]): ProseParagraph[] => [{
  segments: segments.map((segment): ProseSegment => segment.kind === 'text'
    ? segment
    : { kind: 'chip', chipKind: 'variable', refId: segment.key, label: segment.key }),
}]

const segmentsFromParagraph = (segments: ProseSegment[]): RoutineBlockInstructionSegment[] => segments.length === 0
  ? [{ kind: 'text', text: '' }]
  : segments.map((segment) => segment.kind === 'text'
    ? segment
    : { kind: 'slotReference', key: segment.refId, source: `{{slot.${segment.refId}}}` })

const instructionsEqual = (left: RoutineBlockInstructionSegment[], right: RoutineBlockInstructionSegment[]) =>
  left.length === right.length && left.every((segment, index) => {
    const candidate = right[index]
    if (!candidate) return false
    if (segment.kind === 'text') return candidate.kind === 'text' && segment.text === candidate.text
    return candidate.kind === 'slotReference' && segment.key === candidate.key && segment.source === candidate.source
  })

const endingList = (doc: RoutineBlockDoc): RoutineBlockEnding[] => {
  const endings = new Map<string, RoutineBlockEnding>()
  for (const ending of doc.unreferencedEndings) endings.set(ending.stableStepId, ending)
  for (const branch of doc.steps.flatMap((step) => step.branches)) {
    if (branch.target.kind === 'ending' && branch.target.ending) endings.set(branch.target.ending.stableStepId, branch.target.ending)
  }
  return [...endings.values()]
}

function RoutineDocumentReader({ doc }: { doc: RoutineBlockDoc }) {
  const slotNames = new Map(doc.information.map((slot) => [slot.key, slot.key]))
  const index = buildDocumentIndex(doc)
  // The steps are the procedure; the slot list is reference material, so it follows them.
  return <article className="space-y-6 rounded-lg border border-border bg-background p-5" aria-label="Routine document">
    <RoutineDocumentHeader doc={doc} />
    <section aria-labelledby="routine-document-steps"><h3 id="routine-document-steps" className="sr-only">Steps</h3><ol className="divide-y divide-border">{doc.steps.map((step, stepIndex) => <RoutineStepRow key={step.stableStepId} step={step} stepIndex={stepIndex} slotNames={slotNames} index={index} nextStepId={doc.steps[stepIndex + 1]?.stableStepId ?? null} />)}</ol></section>
    <RoutineEndingsSection endings={doc.unreferencedEndings} />
    <RoutineInformationSection slots={doc.information} />
  </article>
}

function GuardEditor({ branch, slots, onChange }: { branch: RoutineBlockBranch; slots: RoutineBlockDoc['information']; onChange: (patch: Partial<RoutineBlockGuard>) => void }) {
  const guard = branch.guard
  if (guard.kind === 'llm') return <label className="block text-xs font-medium text-foreground">Condition<Input aria-label="AI condition" className="mt-1" value={guard.guardText ?? ''} onChange={(event) => onChange({ guardText: event.target.value })} placeholder="Describe what the AI should decide" /></label>
  if (guard.kind === 'slot_filled') return <div className="flex flex-wrap gap-2">{slots.map((slot) => <label key={slot.stableSlotId} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={guard.slotKeys.includes(slot.key)} onChange={(event) => onChange({ slotKeys: event.target.checked ? [...guard.slotKeys, slot.key] : guard.slotKeys.filter((key) => key !== slot.key) })} />{slot.key}</label>)}</div>
  if (guard.kind === 'field') {
    const op = guard.fieldOp ?? 'equals'
    return <div className="grid gap-2 sm:grid-cols-4"><label className="text-xs font-medium text-foreground">Variable<select aria-label="Rule variable" value={guard.fieldRef ?? ''} onChange={(event) => onChange({ fieldRef: event.target.value })} className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"><option value="">Variable…</option>{slots.map((slot) => <option key={slot.key} value={slot.key}>{slot.key}</option>)}</select></label><label className="text-xs font-medium text-foreground">Operator<select aria-label="Rule operator" value={op} onChange={(event) => onChange({ fieldOp: event.target.value as RoutineFieldGuardOp })} className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm">{['equals', 'not_equals', 'in', 'is_present', 'is_absent', 'is_true', 'is_false', 'gt', 'gte', 'lt', 'lte', 'older_than', 'within'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>{fieldGuardOpNeedsValue(op) ? <label className="text-xs font-medium text-foreground">Value<Input aria-label="Rule value" className="mt-1" value={op === 'in' ? (guard.fieldValues ?? []).join(', ') : String(guard.fieldValue ?? '')} onChange={(event) => onChange(op === 'in' ? { fieldValues: event.target.value.split(',').map((value) => value.trim()).filter(Boolean), fieldValue: null } : { fieldValue: event.target.value, fieldValues: null })} placeholder={op === 'in' ? 'Values, separated by commas' : 'Value'} /></label> : null}{fieldGuardOpNeedsUnit(op) ? <label className="text-xs font-medium text-foreground">Unit<select aria-label="Rule unit" value={guard.fieldUnit ?? 'days'} onChange={(event) => onChange({ fieldUnit: event.target.value as RoutineFieldGuardUnit })} className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm">{ROUTINE_FIELD_GUARD_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label> : null}</div>
  }
  if (guard.kind === 'outcome') return <label className="block text-xs font-medium text-foreground">Condition<Input aria-label="Outcome status" className="mt-1" value={guard.outcomeStatus ?? ''} onChange={(event) => onChange({ outcomeStatus: event.target.value })} placeholder="succeeded" /></label>
  if (guard.kind === 'counter') return <label className="block text-xs font-medium text-foreground">Condition<Input aria-label="Counter limit" className="mt-1" type="number" min={1} value={guard.counterLimit ?? ''} onChange={(event) => onChange({ counterLimit: Number(event.target.value) || null })} /></label>
  return <span className="text-xs text-muted-foreground">Otherwise, continue.</span>
}

function DocumentEditor({ initialDoc, onDraftChange }: { initialDoc: RoutineBlockDoc; onDraftChange: (draft: RoutineDefinitionDraft) => void }) {
  const catalog = useContext(RoutineSkillCatalogContext)
  const [doc, setDoc] = useState(initialDoc)
  const [editing, setEditing] = useState<string | null>(null)
  const [slotRemovalError, setSlotRemovalError] = useState<string | null>(null)
  const docRef = useRef(doc)
  const apply = useCallback((edit: (current: RoutineBlockDoc) => RoutineBlockDoc) => {
    const next = edit(docRef.current)
    docRef.current = next
    setDoc(next)
    onDraftChange(draftFromBlockDoc(next))
  }, [onDraftChange])
  const variables = useMemo(() => doc.information.map((slot) => ({ id: slot.key, name: slot.key, type: slot.type, required: slot.required, mutable: slot.mutable ?? false })), [doc.information])
  const endings = useMemo(() => endingList(doc), [doc])
  const slotNames = useMemo(() => new Map(doc.information.map((slot) => [slot.key, slot.key])), [doc.information])
  const documentIndex = useMemo(() => buildDocumentIndex(doc), [doc])
  const addVariable = useCallback((variable: RoutineEditorVariable) => apply((current) => current.information.some((slot) => slot.key === variable.id) ? current : ({ ...current, information: [...current.information, { stableSlotId: variable.id, key: variable.id, type: 'text', required: true, description: null, mutable: false }] })), [apply])
  const targetOptions = (stepId: string) => <><option value="">Choose target…</option>{doc.steps.filter((step) => step.stableStepId !== stepId).map((step) => <option key={step.stableStepId} value={`step:${step.stableStepId}`}>Step: {step.instruction.map((segment) => segment.kind === 'text' ? segment.text : segment.key).join('').trim() || step.stableStepId}</option>)}{endings.map((ending) => <option key={ending.stableStepId} value={`ending:${ending.stableStepId}`}>{formatBranchTargetLabel(ending)}</option>)}</>
  const close = () => setEditing(null)
  return <article className="space-y-6 rounded-lg border border-border bg-background p-5" aria-label="Routine document editor">
    <RoutineDocumentHeader doc={doc} editable onEdit={() => setEditing('activation')} editor={editing === 'activation' ? <div className="mt-3 space-y-3"><Textarea aria-label="Activation trigger" value={doc.activation.triggerDescription} onChange={(event) => apply((current) => updateActivation(current, { triggerDescription: event.target.value }))} placeholder="Starts when…" rows={2} /><div className="grid gap-2 sm:grid-cols-2"><label className="text-xs">Reentry<select aria-label="Reentry" value={doc.activation.reentryMode ?? 'once_per_conversation'} onChange={(event) => apply((current) => updateActivation(current, { reentryMode: event.target.value as RoutineReentryMode }))} className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"><option value="once_per_conversation">Once per conversation</option><option value="always">Every time it matches</option><option value="semantic">Let the assistant decide</option></select></label><label className="text-xs">Priority<Input aria-label="Priority" type="number" value={doc.activation.priority} onChange={(event) => apply((current) => updateActivation(current, { priority: Number(event.target.value) || 0 }))} /></label></div><Button type="button" size="sm" onClick={close}>Done</Button></div> : undefined} />
    <section aria-labelledby="routine-document-steps"><h3 id="routine-document-steps" className="sr-only">Steps</h3><div className="flex items-center justify-end"><DropdownMenu><DropdownMenuTrigger asChild><Button type="button" size="sm" variant="ghost"><Plus className="mr-1 h-4 w-4" />Step</Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => apply((current) => addStep(current, 'chat'))}>Chat</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuLabel>Tool steps</DropdownMenuLabel><p className="px-2 pb-2 text-xs text-muted-foreground">Call a skill, wait for its result, and branch on its outcome.</p>{catalog.skills.map((skill) => <DropdownMenuItem key={skill.skillName} onSelect={() => apply((current) => { const next = addStep(current, 'tool'); return updateStep(next, next.steps.at(-1)!.stableStepId, { toolRef: skill.skillName }) })}>{skill.displayName}</DropdownMenuItem>)}<DropdownMenuSeparator /><DropdownMenuItem onSelect={() => apply((current) => addStep(current, 'approval'))}>Approval</DropdownMenuItem><DropdownMenuLabel>Action steps</DropdownMenuLabel><p className="px-2 pb-2 text-xs text-muted-foreground">Dispatch an outbox side effect, then continue.</p>{catalog.skills.map((skill) => <DropdownMenuItem key={`action-${skill.skillName}`} onSelect={() => apply((current) => { const next = addStep(current, 'action'); return updateStep(next, next.steps.at(-1)!.stableStepId, { actionType: skill.skillName }) })}>{skill.displayName}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div><ol className="mt-1 divide-y divide-border">{doc.steps.map((step, stepIndex) => <StepEditor key={step.stableStepId} step={step} stepIndex={stepIndex} doc={doc} slotNames={slotNames} documentIndex={documentIndex} nextStepId={doc.steps[stepIndex + 1]?.stableStepId ?? null} variables={variables} targetOptions={targetOptions} apply={apply} addVariable={addVariable} editing={editing} setEditing={setEditing} />)}</ol></section>
    <RoutineEndingsSection endings={doc.unreferencedEndings} editable editingEndingId={editing?.startsWith('ending:') ? editing.slice(7) : null} onEdit={(ending) => setEditing(`ending:${ending.stableStepId}`)} renderEditor={(ending) => <div className="flex flex-wrap gap-2"><select aria-label={`${ending.stableStepId} kind`} value={ending.kind} onChange={(event) => apply((current) => updateEnding(current, ending.stableStepId, { kind: event.target.value as RoutineBlockEnding['kind'] }))} className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"><option value="complete">Finish</option><option value="handoff">Hand off</option></select><Input aria-label={`${ending.stableStepId} message`} value={ending.instruction ?? ''} onChange={(event) => apply((current) => updateEnding(current, ending.stableStepId, { instruction: event.target.value }))} placeholder="Message (optional)" /><Button type="button" size="sm" onClick={close}>Done</Button></div>} />
    <RoutineInformationSection slots={doc.information} editable editingSlotId={editing?.startsWith('slot:') ? editing.slice(5) : null} onEditSlot={(slot) => setEditing(`slot:${slot.stableSlotId}`)} renderEditor={(slot) => <div className="grid gap-2 sm:grid-cols-[130px_120px_1fr_auto]"><Input aria-label={`Slot ${slot.key} name`} value={slot.key} onChange={(event) => apply((current) => renameSlot(current, slot.stableSlotId, event.target.value))} /><select aria-label={`Slot ${slot.key} type`} value={slot.type} onChange={(event) => apply((current) => updateSlot(current, slot.stableSlotId, { type: event.target.value as RoutineSlotType }))} className="h-9 rounded-md border border-input bg-transparent px-2 text-sm">{slotTypes.map((type) => <option key={type}>{type}</option>)}</select><Input aria-label={`Slot ${slot.key} description`} value={slot.description ?? ''} onChange={(event) => apply((current) => updateSlot(current, slot.stableSlotId, { description: event.target.value || null }))} placeholder="Description" /><div className="flex items-center gap-2"><Label className="text-xs">Required</Label><Switch checked={slot.required} onCheckedChange={(checked) => apply((current) => updateSlot(current, slot.stableSlotId, { required: checked }))} /><Button type="button" size="sm" onClick={close}>Done</Button><Button type="button" size="icon" variant="ghost" aria-label={`Remove slot ${slot.key}`} onClick={() => { const refs = slotReferences(doc, slot.key); if (refs.length) { setSlotRemovalError(`Can't remove ${slot.key}; it is referenced by ${refs.join(', ')}. Remove those references first.`); return } setSlotRemovalError(null); apply((current) => removeSlot(current, slot.stableSlotId)); close() }}><Trash2 className="h-4 w-4" /></Button></div></div>} />
    {slotRemovalError ? <p role="alert" className="text-xs text-destructive">{slotRemovalError}</p> : null}
  </article>
}

function StepEditor({ step, stepIndex, doc, slotNames, documentIndex, nextStepId, variables, targetOptions, apply, addVariable, editing, setEditing }: { step: RoutineBlockStep; stepIndex: number; doc: RoutineBlockDoc; slotNames: Map<string, string>; documentIndex: RoutineDocumentIndex; nextStepId: string | null; variables: Array<{ id: string; name: string; type: RoutineSlotType; required: boolean; mutable: boolean }>; targetOptions: (stepId: string) => ReactNode; apply: (edit: (current: RoutineBlockDoc) => RoutineBlockDoc) => void; addVariable: (variable: RoutineEditorVariable) => void; editing: string | null; setEditing: (value: string | null) => void }) {
  const catalog = useContext(RoutineSkillCatalogContext)
  const prefix = `step:${step.stableStepId}:`
  const active = editing?.startsWith(prefix) ? editing.slice(prefix.length) : null
  const close = () => setEditing(null)
  const initialInstructionContent = useMemo(() => instructionParagraph(step.instruction), [step.instruction])
  const updateInstruction = useCallback((segments: ProseSegment[]) => {
    const instruction = segmentsFromParagraph(segments)
    if (instructionsEqual(step.instruction, instruction)) return
    apply((current) => replaceInstruction(current, step.stableStepId, instruction))
  }, [apply, step.instruction, step.stableStepId])
  const updateBindingState = (state: { inputBindings?: Record<string, RoutineInputBinding>; outputAssignments?: Record<string, string>; mode?: 'typed' | 'untyped' }) => apply((current) => updateBindings(current, step.stableStepId, state))
  const setActive = (name: string) => setEditing(`${prefix}${name}`)
  const activateStep = () => setActive(instructionIsEmpty(step.instruction) ? 'instruction' : 'step')
  const ref = (step.kind === 'tool' ? step.toolRef : step.kind === 'action' ? step.actionType : '') ?? ''
  const descriptor = ref ? findRoutineSkillDescriptor(catalog.skills, ref, ref) : undefined
  return <RoutineStepRow step={step} stepIndex={stepIndex} slotNames={slotNames} index={documentIndex} nextStepId={nextStepId} editable editing={active} onEditInstruction={() => setActive('instruction')} onEditBinding={() => setActive('binding')} onEditApproval={() => setActive('approval')} onEditBranch={(index) => setActive(`branch:${index}`)} onEditStep={activateStep} instructionEditor={<div className="space-y-2"><RoutineInstructionEditor initialContent={initialInstructionContent} variables={variables} onCreateVariable={addVariable} onChange={updateInstruction} ariaLabel={`Step ${stepIndex + 1} instruction`} /><Button type="button" size="sm" onClick={close}>Done</Button></div>} bindingEditor={<div className="space-y-2 rounded-md bg-muted/40 p-2 text-xs"><div className="flex flex-wrap items-center gap-2"><span>{formatBindingLine(step.inputBindings, step.outputAssignments) ?? 'uses nothing → sets nothing'}</span><RoutineSkillCatalogPopover skillName={ref} label="Edit bindings" bindingState={{ inputBindings: step.inputBindings, outputAssignments: step.outputAssignments, mode: step.mode }} availableVariables={variables.map((variable) => variable.id)} onBindingStateChange={updateBindingState}><Button type="button" size="sm" variant="outline">Edit inputs</Button></RoutineSkillCatalogPopover><Button type="button" size="sm" onClick={close}>Done</Button></div><BindingAssignments assignments={step.outputAssignments ?? {}} onChange={(outputAssignments) => updateBindingState({ inputBindings: step.inputBindings, outputAssignments, mode: step.mode })} onCreateVariable={addVariable} /></div>} approvalEditor={<ApprovalEditor step={step} apply={apply} onDone={close} />} branchEditor={(index, branch) => <BranchEditor branch={branch} branchIndex={index} step={step} doc={doc} targetOptions={targetOptions} apply={apply} onDone={close} />} stepEditor={<div className="mt-3 space-y-3 rounded-md bg-muted/40 p-3"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{step.kind === 'approval' ? 'Approval' : step.kind}</Badge>{step.kind === 'tool' || step.kind === 'action' ? <select aria-label={`${step.stableStepId} catalog item`} value={ref} onChange={(event) => apply((current) => updateStep(current, step.stableStepId, step.kind === 'tool' ? { toolRef: event.target.value } : { actionType: event.target.value }))} className="h-9 min-w-44 rounded-md border border-input bg-transparent px-2 text-sm"><option value="">Choose from catalog…</option>{catalog.skills.map((skill) => <option key={skill.skillName} value={skill.skillName}>{skill.displayName}</option>)}</select> : null}{descriptor ? <span className="text-xs text-muted-foreground">{descriptor.displayName}</span> : null}<span className="flex-1" /><Button type="button" size="icon" variant="ghost" disabled={stepIndex === 0} aria-label="Move step up" onClick={() => apply((current) => moveStep(current, step.stableStepId, -1))}><ArrowUp className="h-4 w-4" /></Button><Button type="button" size="icon" variant="ghost" disabled={stepIndex === doc.steps.length - 1} aria-label="Move step down" onClick={() => apply((current) => moveStep(current, step.stableStepId, 1))}><ArrowDown className="h-4 w-4" /></Button><Button type="button" size="icon" variant="ghost" aria-label="Remove step" onClick={() => apply((current) => removeStep(current, step.stableStepId))}><Trash2 className="h-4 w-4" /></Button></div>{step.kind !== 'approval' ? <Button type="button" size="sm" variant="outline" onClick={() => { apply((current) => addBranch(current, step.stableStepId, 'field')); setActive(`branch:${step.branches.length}`) }}><Plus className="mr-1 h-3.5 w-3.5" />Condition</Button> : null}<Button type="button" size="sm" onClick={close}>Done</Button></div>} />
}

function BranchEditor({ branch, branchIndex, step, doc, targetOptions, apply, onDone }: { branch: RoutineBlockBranch; branchIndex: number; step: RoutineBlockStep; doc: RoutineBlockDoc; targetOptions: (stepId: string) => ReactNode; apply: (edit: (current: RoutineBlockDoc) => RoutineBlockDoc) => void; onDone: () => void }) {
  return <div className="space-y-3"><div className="flex items-center justify-between border-b border-border pb-2"><span className="text-xs font-semibold text-foreground">Branch {branchIndex + 1}</span><Button type="button" variant="ghost" size="sm" aria-label="Remove condition" onClick={() => { apply((current) => removeBranch(current, step.stableStepId, branchIndex)); onDone() }}><Trash2 className="mr-1 h-4 w-4" />Remove</Button></div><div className="grid gap-3 sm:grid-cols-[130px_150px_minmax(0,1fr)]"><label className="text-xs font-medium text-foreground">Decision<select aria-label="Decision kind" value={branch.guard.kind === 'llm' ? 'llm' : 'rule'} onChange={(event) => apply((current) => changeBranchGuardKind(current, step.stableStepId, branchIndex, event.target.value === 'llm' ? 'llm' : 'field'))} className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"><option value="rule">Rule</option><option value="llm">AI decides</option></select></label>{branch.guard.kind !== 'llm' ? <label className="text-xs font-medium text-foreground">Condition<select aria-label="Rule kind" value={branch.guard.kind} onChange={(event) => apply((current) => changeBranchGuardKind(current, step.stableStepId, branchIndex, event.target.value as RoutineGuardKind))} className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm">{guardKinds.map((kind) => <option key={kind} value={kind}>{kind.replaceAll('_', ' ')}</option>)}</select></label> : <span />}<div className="space-y-2"><label className="block text-xs font-medium text-foreground">Target<select aria-label="Branch target" value={branch.target.kind === 'step' ? `step:${branch.target.stableStepId}` : `ending:${branch.target.terminalId}`} onChange={(event) => { const [kind, id] = event.target.value.split(':'); apply((current) => kind === 'step' ? targetBranchAtStep(current, step.stableStepId, branchIndex, id!) : referenceEnding(current, step.stableStepId, branchIndex, id!)) }} className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm">{targetOptions(step.stableStepId)}</select></label><div><p className="text-xs text-muted-foreground">or create new:</p><div className="mt-1 flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" onClick={() => apply((current) => createEndingForBranch(current, step.stableStepId, branchIndex, 'complete'))}>New finish</Button><Button type="button" size="sm" variant="outline" onClick={() => apply((current) => createEndingForBranch(current, step.stableStepId, branchIndex, 'handoff'))}>New hand-off</Button></div></div></div></div><GuardEditor branch={branch} slots={doc.information} onChange={(patch) => apply((current) => updateBranchGuard(current, step.stableStepId, branchIndex, patch))} />{branch.target.kind === 'ending' && branchEnding(branch) ? <label className="block text-xs font-medium text-foreground">Ending message<Input aria-label="Ending message" className="mt-1" value={branchEnding(branch)?.instruction ?? ''} onChange={(event) => { const ending = branchEnding(branch); if (ending) apply((current) => updateEnding(current, ending.stableStepId, { instruction: event.target.value })) }} placeholder="Ending message" /></label> : null}<Button type="button" size="sm" onClick={onDone}>Done</Button></div>
}

function BindingAssignments({ assignments, onChange, onCreateVariable }: { assignments: Record<string, string>; onChange: (assignments: Record<string, string>) => void; onCreateVariable: (variable: RoutineEditorVariable) => void }) {
  const entries = Object.entries(assignments)
  const update = (index: number, key: string, value: string) => {
    const next = Object.fromEntries(entries.filter((_, candidate) => candidate !== index))
    const normalized = value.trim() ? slugifyVariableKey(value) : ''
    if (key.trim()) next[key.trim()] = normalized
    onChange(next)
    if (value.trim()) onCreateVariable({ id: normalized, name: value.trim() })
  }
  return <div className="space-y-1"><div className="flex items-center justify-between"><span className="font-medium">Sets</span><Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...assignments, [`output_${entries.length + 1}`]: '' })}><Plus className="mr-1 h-3.5 w-3.5" />Output</Button></div>{entries.map(([output, variable], index) => <div key={`${output}-${index}`} className="grid grid-cols-[1fr_1fr_auto] gap-2"><Input aria-label={`Output ${index + 1} name`} value={output} onChange={(event) => update(index, event.target.value, variable)} placeholder="Output" /><Input aria-label={`Output ${index + 1} variable`} value={variable} onChange={(event) => update(index, output, event.target.value)} placeholder="Existing or new variable" /><Button type="button" size="sm" variant="ghost" aria-label={`Remove output ${index + 1}`} onClick={() => onChange(Object.fromEntries(entries.filter((_, candidate) => candidate !== index)))}><Trash2 className="h-4 w-4" /></Button></div>)}</div>
}

function ApprovalEditor({ step, apply, onDone }: { step: RoutineBlockStep; apply: (edit: (current: RoutineBlockDoc) => RoutineBlockDoc) => void; onDone: () => void }) {
  const options = step.options ?? []
  return <div className="space-y-2 rounded-md bg-violet-500/5 p-3"><Label>Question</Label><Textarea aria-label="Approval question" value={step.instruction.map((segment) => segment.kind === 'text' ? segment.text : `{{slot.${segment.key}}}`).join('')} onChange={(event) => apply((current) => updateApproval(current, step.stableStepId, { instruction: [{ kind: 'text', text: event.target.value }] }))} rows={2} /><Label>Capture key</Label><Input aria-label="Approval capture key" value={step.captureKey ?? ''} onChange={(event) => apply((current) => updateApproval(current, step.stableStepId, { captureKey: slugifyVariableKey(event.target.value) }))} />{options.map((option, index) => <div key={option.id} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"><Input aria-label={`Approval option ${index + 1} label`} value={option.label} onChange={(event) => apply((current) => updateApproval(current, step.stableStepId, { options: options.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) }))} placeholder="Label" /><Input aria-label={`Approval option ${index + 1} description`} value={option.description ?? ''} onChange={(event) => apply((current) => updateApproval(current, step.stableStepId, { options: options.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item) }))} placeholder="Description" /><Button type="button" size="sm" variant="ghost" disabled={options.length <= 2} onClick={() => apply((current) => updateApproval(current, step.stableStepId, { options: options.filter((_, itemIndex) => itemIndex !== index) }))}><Trash2 className="h-4 w-4" /></Button></div>)}<div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => apply((current) => updateApproval(current, step.stableStepId, { options: [...options, { id: `option_${options.length + 1}`, label: '', description: '' }] }))}><Plus className="mr-1 h-3.5 w-3.5" />Option</Button><Button type="button" size="sm" onClick={onDone}>Done</Button></div><p className="text-xs text-muted-foreground">At least two options are required.</p></div>
}

export function RoutineDocumentTab({ draft, isReadOnly = true, onDraftChange }: { draft: RoutineDefinitionDraft; isReadOnly?: boolean; onDraftChange?: (draft: RoutineDefinitionDraft) => void }) {
  const result = useMemo(() => routineToBlockDoc(draft), [draft])
  if (!result.ok) return <div className="rounded-lg border border-dashed border-border p-4" role="status"><p className="font-medium text-foreground">This routine can’t be displayed as a document yet.</p><p className="mt-1 text-sm text-muted-foreground">Use the <strong>Form</strong> tab to resolve the following:</p><ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{result.diagnostics.map((diagnostic) => <li key={`${diagnostic.code}-${diagnostic.message}`}>{diagnostic.message}{diagnostic.code === 'schema_validation' ? <ul className="mt-1 list-disc space-y-1 pl-5">{diagnostic.issues.map((issue, index) => <li key={`${issue.path.join('.')}-${issue.message}-${index}`}>{issue.path.join('.')}: {issue.message}</li>)}</ul> : null}</li>)}</ul></div>
  return isReadOnly || !onDraftChange ? <RoutineDocumentReader doc={result.doc} /> : <DocumentEditor initialDoc={result.doc} onDraftChange={onDraftChange} />
}
