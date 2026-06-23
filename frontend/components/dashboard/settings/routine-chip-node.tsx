'use client'

import { useRef, useState, type ComponentType, type JSX } from 'react'
import { AlertTriangle, BadgeCheck, ChevronDown, CornerUpRight, Flag, Gavel, Plus, Sparkles, Trash2, Zap, type LucideIcon } from 'lucide-react'
import {
  $getNodeByKey,
  $getRoot,
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import { $isHeadingNode } from '@lexical/rich-text'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConditionBuilderDialog, type ConditionDraft } from '@/components/dashboard/settings/routine-condition-builder-dialog'
import { useSkillDescriptor, RoutineSkillCatalogPopover } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { APPROVAL_OPTION_LIMIT } from '@/lib/routine-approval'
import type { RoutineFieldGuardOp, RoutineFieldGuardUnit, RoutineSlotType } from '@/lib/api-types'
import { ROUTINE_SLOT_TYPES, slugifyVariableKey, type ApprovalDocOption, type RoutineInputBinding, type RoutineSkillBindingState, type RoutineStepMode } from '@/lib/routine-prose'

import { useRoutineVariables } from '@/components/dashboard/settings/routine-variables-context'

// A chip is an atomic inline reference the author picks instead of typing raw syntax.
// Each kind renders with its own colour + glyph; the kind/type/comparison live as
// metadata on the node, never as visible syntax. A `skill` chip names a skill defined
// elsewhere (compiles to a tool step the runner dispatches through the skill port); a
// `condition` chip is a structured comparison ("decided in code"); the others are
// references/targets. An `end` chip is a branch target that completes the routine (the
// counterpart to a `handoff` chip, which escalates).
export type RoutineChipKind = 'variable' | 'skill' | 'handoff' | 'step' | 'condition' | 'end' | 'approval' | 'decision'

export type RoutineFieldGuardValue = string | number | boolean

// A branch target an approval option can route to, surfaced in the approval dialog.
export type ApprovalChipTarget = { id: string; label: string }
export type ApprovalChipState = { captureKey: string; options: ApprovalDocOption[] }

export type SerializedChipNode = Spread<
  {
    chipKind: RoutineChipKind
    refId: string
    label: string
    op?: RoutineFieldGuardOp
    value?: RoutineFieldGuardValue | null
    values?: RoutineFieldGuardValue[] | null
    unit?: RoutineFieldGuardUnit | null
    counterLimit?: number | null
    inputBindings?: Record<string, RoutineInputBinding>
    outputAssignments?: Record<string, string>
    mode?: RoutineStepMode
    captureKey?: string | null
    options?: ApprovalDocOption[]
  },
  SerializedLexicalNode
>

const KIND_META: Record<RoutineChipKind, { className: string; icon: LucideIcon | null }> = {
  variable: { className: 'border-amber-300 bg-amber-100 text-amber-900', icon: null },
  skill: { className: 'border-emerald-300 bg-emerald-100 text-emerald-900', icon: Zap },
  handoff: { className: 'border-rose-300 bg-rose-100 text-rose-900', icon: CornerUpRight },
  step: { className: 'border-sky-300 bg-sky-100 text-sky-900', icon: CornerUpRight },
  condition: { className: 'border-indigo-300 bg-indigo-100 text-indigo-900', icon: BadgeCheck },
  end: { className: 'border-slate-300 bg-slate-100 text-slate-700', icon: Flag },
  approval: { className: 'border-violet-300 bg-violet-100 text-violet-900', icon: Gavel },
  decision: { className: 'border-violet-300 bg-violet-100 text-violet-900', icon: Gavel },
}

function ChipBadge({
  kind,
  label,
  type,
  className,
  icon,
  suffix,
}: {
  kind: RoutineChipKind
  label: string
  type: RoutineSlotType | null
  className?: string
  icon?: LucideIcon | null
  suffix?: string
}): JSX.Element {
  const meta = KIND_META[kind]
  const Icon: ComponentType<{ className?: string }> | null = icon === undefined ? meta.icon : icon
  return (
    <span
      className={`inline-flex select-none items-center gap-1 rounded-md border px-1.5 py-0 text-xs font-medium ${className ?? meta.className}`}
    >
      {Icon ? <Icon className="h-3 w-3" /> : null}
      {label}
      {/* The type is part of the variable's identity, so show it on the chip face —
          it also drives which exact checks the author can build on the variable. */}
      {type ? <span className="font-normal opacity-60">· {type}</span> : null}
      {suffix ? <span className="font-normal opacity-70">· {suffix}</span> : null}
      {kind === 'variable' ? <ChevronDown className="h-3 w-3 opacity-50" /> : null}
    </span>
  )
}

// The approval gate form. Mounted fresh each time the dialog opens (see ApprovalChipDialog),
// so its local state seeds from `initial` at mount — no effect-driven re-seeding needed.
function ApprovalDialogBody({
  targets,
  initial,
  onConfirm,
  onOpenChange,
  onRemove,
}: {
  targets: ApprovalChipTarget[]
  initial: ApprovalChipState
  onConfirm: (state: ApprovalChipState) => void
  onOpenChange: (open: boolean) => void
  onRemove?: () => void
}): JSX.Element {
  // The decision name (capture key) is a technical id most authors never need to set, so it
  // defaults to a sensible value and stays optional in the form.
  const [captureKey, setCaptureKey] = useState(initial.captureKey || 'decision')
  const [options, setOptions] = useState<ApprovalDocOption[]>(
    // A fresh gate seeds the two choices every approval needs (approve + decline); the author
    // points each at a branch. Editing an existing gate keeps its saved choices.
    initial.options.length > 0
      ? initial.options
      : [{ id: 'approve', label: 'Approve', target: '' }, { id: 'decline', label: 'Decline', target: '' }],
  )

  const updateOption = (index: number, patch: Partial<ApprovalDocOption>) =>
    setOptions((prev) => prev.map((option, candidate) => (candidate === index ? { ...option, ...patch } : option)))
  const addOption = () => setOptions((prev) => [...prev, { id: `option_${prev.length + 1}`, label: '', target: '' }])
  const removeOption = (index: number) => setOptions((prev) => prev.filter((_, candidate) => candidate !== index))

  const canConfirm = options.length > 0
    && options.every((option) => option.label.trim().length > 0 && (option.target ?? '').length > 0)

  const confirm = () => {
    onConfirm({
      captureKey: slugifyVariableKey(captureKey || 'decision'),
      // The dialog has no id field, so the option id is keyed off its label (the gate owns
      // all its own edges, so regenerating ids from labels never dangles a reference).
      options: options.map((option, index) => ({
        id: slugifyVariableKey(option.label || option.id || `option_${index + 1}`),
        label: option.label.trim(),
        ...(option.description?.trim() ? { description: option.description.trim() } : {}),
        target: option.target,
      })),
    })
    onOpenChange(false)
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Approval gate</DialogTitle>
        <DialogDescription>
          The routine stops here and waits for a person to pick one of the choices below. Whatever they
          pick, the routine carries on to the step you set for that choice.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Choices</Label>
            <Button type="button" size="sm" variant="outline" disabled={options.length >= APPROVAL_OPTION_LIMIT} onClick={addOption}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add choice
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Each choice is a button the person sees. Pick where the routine goes next for each one.</p>
          {options.map((option, index) => (
            <div key={`approval-option-${index}`} className="grid items-center gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_auto_160px_auto]">
              <Input
                aria-label={`Option ${index + 1} label`}
                placeholder="What the person picks (e.g. Approve)"
                value={option.label}
                onChange={(event) => updateOption(index, { label: event.target.value })}
              />
              <span className="hidden text-sm text-muted-foreground sm:inline" aria-hidden="true">then go to</span>
              <select
                aria-label={`Option ${index + 1} target`}
                value={option.target}
                onChange={(event) => updateOption(index, { target: event.target.value })}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              >
                <option value="">a step or end…</option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>{target.label}</option>
                ))}
              </select>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeOption(index)}
                aria-label={`Remove option ${index + 1}`}
                disabled={options.length <= 1}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <Input
                aria-label={`Option ${index + 1} description`}
                placeholder="Extra detail for the person deciding (optional)"
                value={option.description ?? ''}
                onChange={(event) => updateOption(index, { description: event.target.value })}
                className="sm:col-span-4"
              />
            </div>
          ))}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="approvalCaptureKey" className="text-xs text-muted-foreground">Decision name</Label>
          <Input
            id="approvalCaptureKey"
            aria-label="Decision name"
            value={captureKey}
            onChange={(event) => setCaptureKey(event.target.value)}
            placeholder="decision"
          />
          <p className="text-xs text-muted-foreground">Records which choice was made. Change it only if a later step needs to read the result (e.g. <code>refund_decision</code>).</p>
        </div>
      </div>
      <DialogFooter className="sm:justify-between">
        {onRemove ? (
          <Button type="button" variant="ghost" onClick={() => { onRemove(); onOpenChange(false) }}>Remove</Button>
        ) : <span />}
        <Button type="button" onClick={confirm} disabled={!canConfirm}>Save approval</Button>
      </DialogFooter>
    </DialogContent>
  )
}

// Self-contained editor for an approval gate: the capture slot plus the options a human
// chooses between, each routed to a step or terminal. Used both to insert a new approval
// chip (from the toolbar) and to edit an existing one. The body mounts only while open so
// it always seeds from the latest `initial`.
export function ApprovalChipDialog({
  open,
  onOpenChange,
  targets,
  initial,
  onConfirm,
  onRemove,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  targets: ApprovalChipTarget[]
  initial: ApprovalChipState
  onConfirm: (state: ApprovalChipState) => void
  onRemove?: () => void
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <ApprovalDialogBody targets={targets} initial={initial} onConfirm={onConfirm} onOpenChange={onOpenChange} onRemove={onRemove} />
      ) : null}
    </Dialog>
  )
}

// Choices-only editor for an inline decision declaration: the decision name plus the choices
// (label + optional description). Unlike the block-chip dialog there are NO target pickers —
// routing lives on the branch lines that follow the chip in the document.
function DecisionDialogBody({
  initial,
  onConfirm,
  onOpenChange,
  onRemove,
}: {
  initial: ApprovalChipState
  onConfirm: (state: ApprovalChipState) => void
  onOpenChange: (open: boolean) => void
  onRemove?: () => void
}): JSX.Element {
  const [captureKey, setCaptureKey] = useState(initial.captureKey || 'decision')
  const [options, setOptions] = useState<ApprovalDocOption[]>(
    initial.options.length > 0 ? initial.options : [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
  )

  const updateOption = (index: number, patch: Partial<ApprovalDocOption>) =>
    setOptions((prev) => prev.map((option, candidate) => (candidate === index ? { ...option, ...patch } : option)))
  const addOption = () => setOptions((prev) => [...prev, { id: `option_${prev.length + 1}`, label: '' }])
  const removeOption = (index: number) => setOptions((prev) => prev.filter((_, candidate) => candidate !== index))

  const canConfirm = options.length >= 2 && options.every((option) => option.label.trim().length > 0)

  const confirm = () => {
    onConfirm({
      captureKey: slugifyVariableKey(captureKey || 'decision'),
      options: options.map((option, index) => ({
        id: slugifyVariableKey(option.label || option.id || `option_${index + 1}`),
        label: option.label.trim(),
        ...(option.description?.trim() ? { description: option.description.trim() } : {}),
      })),
    })
    onOpenChange(false)
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Decision</DialogTitle>
        <DialogDescription>
          The routine pauses here and a person picks one of these choices. Set where each choice
          goes on the branch lines below the chip (<code>if decision is …</code>).
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Choices</Label>
            <Button type="button" size="sm" variant="outline" disabled={options.length >= APPROVAL_OPTION_LIMIT} onClick={addOption}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add choice
            </Button>
          </div>
          {options.map((option, index) => (
            <div key={`decision-option-${index}`} className="grid items-center gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_auto]">
              <Input
                aria-label={`Choice ${index + 1} label`}
                placeholder="What the person picks (e.g. Approve)"
                value={option.label}
                onChange={(event) => updateOption(index, { label: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeOption(index)}
                aria-label={`Remove choice ${index + 1}`}
                disabled={options.length <= 2}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <Input
                aria-label={`Choice ${index + 1} description`}
                placeholder="Extra detail for the person deciding (optional)"
                value={option.description ?? ''}
                onChange={(event) => updateOption(index, { description: event.target.value })}
                className="sm:col-span-2"
              />
            </div>
          ))}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="decisionCaptureKey" className="text-xs text-muted-foreground">Decision name</Label>
          <Input
            id="decisionCaptureKey"
            aria-label="Decision name"
            value={captureKey}
            onChange={(event) => setCaptureKey(event.target.value)}
            placeholder="decision"
          />
          <p className="text-xs text-muted-foreground">Records which choice was made. Change it only if a later step reads the result.</p>
        </div>
      </div>
      <DialogFooter className="sm:justify-between">
        {onRemove ? (
          <Button type="button" variant="ghost" onClick={() => { onRemove(); onOpenChange(false) }}>Remove</Button>
        ) : <span />}
        <Button type="button" onClick={confirm} disabled={!canConfirm}>Save decision</Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function DecisionChipDialog({
  open,
  onOpenChange,
  initial,
  onConfirm,
  onRemove,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: ApprovalChipState
  onConfirm: (state: ApprovalChipState) => void
  onRemove?: () => void
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DecisionDialogBody initial={initial} onConfirm={onConfirm} onOpenChange={onOpenChange} onRemove={onRemove} />
      ) : null}
    </Dialog>
  )
}

// The branch targets an approval option can route to, drawn from the document's titled
// steps plus the two terminals the prose editor always exposes.
export function approvalChipTargets(stepTargets: ApprovalChipTarget[]): ApprovalChipTarget[] {
  return [...stepTargets, { id: 'done', label: 'End (complete)' }, { id: 'handoff', label: 'Handoff' }]
}

function ChipMenu({ nodeKey, kind, refId, label }: { nodeKey: NodeKey; kind: RoutineChipKind; refId: string; label: string }): JSX.Element {
  const [editor] = useLexicalComposerContext()
  const { getType, setType, variables } = useRoutineVariables()
  const type = kind === 'variable' ? getType(refId) : null
  const skillCatalog = useSkillDescriptor(refId, label)

  const readBindingState = (): RoutineSkillBindingState => {
    let next: RoutineSkillBindingState = {}
    editor.getEditorState().read(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isChipNode(node)) next = node.getSkillBindingState()
    })
    return next
  }

  const bindingState = readBindingState()
  const [isCatalogOpen, setIsCatalogOpen] = useState(false)
  const [draftBindingState, setDraftBindingState] = useState<RoutineSkillBindingState>(bindingState)
  const draftBindingStateRef = useRef<RoutineSkillBindingState>(bindingState)

  const commitBindingState = (next: RoutineSkillBindingState) => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isChipNode(node)) node.setSkillBindingState(next)
    })
  }

  const handleCatalogOpenChange = (open: boolean) => {
    if (open) {
      const next = readBindingState()
      draftBindingStateRef.current = next
      setDraftBindingState(next)
      setIsCatalogOpen(true)
      return
    }
    setIsCatalogOpen(false)
    commitBindingState(draftBindingStateRef.current)
  }

  const updateDraftBindingState = (next: RoutineSkillBindingState) => {
    draftBindingStateRef.current = next
    setDraftBindingState(next)
  }

  const [isConditionBuilderOpen, setIsConditionBuilderOpen] = useState(false)

  // Demote a decided-in-code check to decided-by-AI: keep the comparison as an AI condition
  // CHIP (carrying the phrase), not bare text — so it stays togglable back to decided-in-code
  // (issue: "once decided by AI, can't go back"). Compiles to an `llm` guard.
  const demoteToAi = () => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if (!node) return
      node.replace($createAiConditionChipNode(label))
    })
  }

  // Promote a decided-by-AI condition to decided-in-code: the structured comparison from the
  // builder replaces the AI chip, producing a deterministic field guard.
  const promoteToCode = (condition: ConditionDraft) => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if (!node) return
      node.replace($createConditionChipNode(condition.refId, condition.op, condition.label, condition.value, condition.values, condition.unit))
    })
  }

  const removeSelf = () => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      node?.remove()
    })
  }

  const [isApprovalOpen, setIsApprovalOpen] = useState(false)
  const [isDecisionOpen, setIsDecisionOpen] = useState(false)

  if (kind === 'decision') {
    // The inline decision declaration: just the choices the person picks between. Routing is
    // authored on the branch lines that follow this chip, so the chip stays small.
    let initial: ApprovalChipState = { captureKey: '', options: [] }
    editor.getEditorState().read(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isChipNode(node)) initial = node.getApprovalState()
    })
    const commitDecisionState = (state: ApprovalChipState) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isChipNode(node)) node.setApprovalState(state)
      })
    }
    const choices = initial.options.map((option) => option.label || option.id).join(' / ')
    return (
      <>
        <button
          type="button"
          contentEditable={false}
          data-routine-chip={kind}
          className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-violet-300 bg-violet-100 px-1.5 py-0 align-baseline text-xs font-medium text-violet-900 outline-none"
          onClick={() => setIsDecisionOpen(true)}
        >
          <Gavel className="h-3 w-3" />
          {initial.captureKey && initial.captureKey !== 'decision' ? initial.captureKey : 'decision'}
          {choices ? <span className="font-normal opacity-70">· {choices}</span> : null}
        </button>
        <DecisionChipDialog
          open={isDecisionOpen}
          onOpenChange={setIsDecisionOpen}
          initial={initial}
          onConfirm={commitDecisionState}
          onRemove={removeSelf}
        />
      </>
    )
  }

  if (kind === 'approval') {
    const stepTargets: ApprovalChipTarget[] = []
    let initial: ApprovalChipState = { captureKey: '', options: [] }
    editor.getEditorState().read(() => {
      for (const block of $getRoot().getChildren()) {
        if ($isHeadingNode(block)) {
          const title = block.getTextContent().trim()
          if (title) stepTargets.push({ id: slugifyVariableKey(title), label: title })
        }
      }
      const node = $getNodeByKey(nodeKey)
      if ($isChipNode(node)) initial = node.getApprovalState()
    })
    const commitApprovalState = (state: ApprovalChipState) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isChipNode(node)) node.setApprovalState(state)
      })
    }
    // Resolve a stored branch target (a step id or a terminal id) to the label the author
    // reads, so the gate renders as the SOP — "if <choice> then <where>" — not an opaque badge.
    const targetLabel = (target: string): string => {
      if (!target || target === 'done') return 'End'
      if (target === 'handoff') return 'Handoff'
      return stepTargets.find((candidate) => candidate.id === target)?.label ?? target
    }
    return (
      <>
        {/* The whole gate reads as conditional prose, not a form behind a badge: the choices
            and where each one routes are visible inline. Click anywhere on it to edit. */}
        <button
          type="button"
          contentEditable={false}
          data-routine-chip={kind}
          className="mx-0.5 inline-flex flex-col gap-0.5 rounded-md border border-violet-300 bg-violet-100 px-2 py-1 text-left align-baseline text-xs text-violet-900 outline-none"
          onClick={() => setIsApprovalOpen(true)}
        >
          <span className="inline-flex items-center gap-1 font-medium">
            <Gavel className="h-3 w-3" />
            Approval — a person chooses:
            {initial.captureKey && initial.captureKey !== 'decision'
              ? <span className="font-normal opacity-70">· records {initial.captureKey}</span>
              : null}
          </span>
          {initial.options.length === 0 ? (
            <span className="opacity-70">no choices yet — click to add</span>
          ) : (
            initial.options.map((option, index) => (
              <span key={index} className="font-normal">
                if <span className="font-medium">{option.label || 'this choice'}</span>
                {' '}then <span className="font-medium">{targetLabel(option.target ?? '')}</span>
              </span>
            ))
          )}
        </button>
        <ApprovalChipDialog
          open={isApprovalOpen}
          onOpenChange={setIsApprovalOpen}
          targets={approvalChipTargets(stepTargets)}
          initial={initial}
          onConfirm={commitApprovalState}
          onRemove={removeSelf}
        />
      </>
    )
  }

  if (kind === 'skill') {
    const resolvedLabel = skillCatalog.descriptor?.displayName ?? label
    const isUnknownSkill = !skillCatalog.isLoading && !skillCatalog.descriptor
    return (
      <RoutineSkillCatalogPopover
        skillName={refId}
        label={resolvedLabel}
        bindingState={isCatalogOpen ? draftBindingState : bindingState}
        availableVariables={variables.map((variable) => variable.id)}
        open={isCatalogOpen}
        onOpenChange={handleCatalogOpenChange}
        onBindingStateChange={updateDraftBindingState}
        onRemove={removeSelf}
      >
        <button type="button" contentEditable={false} data-routine-chip={kind} className="mx-0.5 cursor-pointer align-baseline outline-none">
          <ChipBadge
            kind={kind}
            label={isUnknownSkill ? label : resolvedLabel}
            type={type}
            className={isUnknownSkill ? 'border-amber-400 bg-amber-100 text-amber-950 dark:border-amber-500/70 dark:bg-amber-500/15 dark:text-amber-100' : undefined}
            icon={isUnknownSkill ? AlertTriangle : undefined}
            suffix={isUnknownSkill ? 'unknown skill' : undefined}
          />
        </button>
      </RoutineSkillCatalogPopover>
    )
  }

  if (kind === 'condition') {
    // A condition shows its decision mode and can be switched either way: decided-in-code
    // (a structured rule, op set) ⇄ decided-by-AI (a free phrase, no op). The mode is read
    // from the node so it reflects the current state after a toggle.
    let isAi = false
    editor.getEditorState().read(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isChipNode(node)) isAi = node.getChipOp() === null
    })
    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" contentEditable={false} data-routine-chip={kind} data-guard-mode={isAi ? 'ai' : 'code'} className="mx-0.5 cursor-pointer align-baseline outline-none">
              <ChipBadge
                kind={kind}
                label={label}
                type={null}
                icon={isAi ? Sparkles : BadgeCheck}
                suffix={isAi ? 'AI decides' : 'rule'}
                className={isAi ? 'border-violet-300 bg-violet-100 text-violet-900' : undefined}
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>{isAi ? 'Decided by AI' : 'Decided in code'}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {isAi ? (
              <DropdownMenuItem onClick={() => setIsConditionBuilderOpen(true)}>Switch to decided in code</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={demoteToAi}>Switch to decided by AI</DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={removeSelf}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ConditionBuilderDialog
          open={isConditionBuilderOpen}
          onOpenChange={setIsConditionBuilderOpen}
          variables={variables}
          onConfirm={promoteToCode}
          onSetVariableType={setType}
        />
      </>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" contentEditable={false} data-routine-chip={kind} className="mx-0.5 cursor-pointer align-baseline outline-none">
          <ChipBadge kind={kind} label={label} type={type} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {kind === 'variable' ? (
          <>
            <DropdownMenuLabel>Variable type</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={getType(refId)} onValueChange={(value) => setType(refId, value as RoutineSlotType)}>
              {ROUTINE_SLOT_TYPES.map((type) => (
                <DropdownMenuRadioItem key={type} value={type}>{type}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onClick={removeSelf}>Remove</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export class ChipNode extends DecoratorNode<JSX.Element> {
  __chipKind: RoutineChipKind
  __refId: string
  __label: string
  __op: RoutineFieldGuardOp | null
  __value: RoutineFieldGuardValue | null
  __values: RoutineFieldGuardValue[] | null
  __unit: RoutineFieldGuardUnit | null
  __counterLimit: number | null
  __inputBindings: Record<string, RoutineInputBinding>
  __outputAssignments: Record<string, string>
  __mode: RoutineStepMode | null
  __captureKey: string | null
  __options: ApprovalDocOption[]

  static getType(): string {
    return 'routine-chip'
  }

  static clone(node: ChipNode): ChipNode {
    return new ChipNode(
      node.__chipKind,
      node.__refId,
      node.__label,
      node.__key,
      node.__op,
      node.__value,
      node.__values,
      node.__unit,
      node.__counterLimit,
      node.__inputBindings,
      node.__outputAssignments,
      node.__mode,
      node.__captureKey,
      node.__options,
    )
  }

  static importJSON(serialized: SerializedChipNode): ChipNode {
    return new ChipNode(
      serialized.chipKind,
      serialized.refId,
      serialized.label,
      undefined,
      serialized.op ?? null,
      serialized.value ?? null,
      serialized.values ?? null,
      serialized.unit ?? null,
      serialized.counterLimit ?? null,
      serialized.inputBindings ?? {},
      serialized.outputAssignments ?? {},
      serialized.mode ?? null,
      serialized.captureKey ?? null,
      serialized.options ?? [],
    )
  }

  constructor(
    chipKind: RoutineChipKind,
    refId: string,
    label: string,
    key?: NodeKey,
    op: RoutineFieldGuardOp | null = null,
    value: RoutineFieldGuardValue | null = null,
    values: RoutineFieldGuardValue[] | null = null,
    unit: RoutineFieldGuardUnit | null = null,
    counterLimit: number | null = null,
    inputBindings: Record<string, RoutineInputBinding> = {},
    outputAssignments: Record<string, string> = {},
    mode: RoutineStepMode | null = null,
    captureKey: string | null = null,
    options: ApprovalDocOption[] = [],
  ) {
    super(key)
    this.__chipKind = chipKind
    this.__refId = refId
    this.__label = label
    this.__op = op
    this.__value = value
    this.__values = values
    this.__unit = unit
    this.__counterLimit = counterLimit
    this.__inputBindings = inputBindings
    this.__outputAssignments = outputAssignments
    this.__mode = mode
    this.__captureKey = captureKey
    this.__options = options
  }

  exportJSON(): SerializedChipNode {
    return {
      type: 'routine-chip',
      version: 1,
      chipKind: this.__chipKind,
      refId: this.__refId,
      label: this.__label,
      op: this.__op ?? undefined,
      value: this.__value,
      values: this.__values,
      unit: this.__unit,
      counterLimit: this.__counterLimit,
      inputBindings: this.__inputBindings,
      outputAssignments: this.__outputAssignments,
      mode: this.__mode ?? undefined,
      captureKey: this.__captureKey,
      options: this.__options,
    }
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span')
    span.style.display = 'inline-block'
    return span
  }

  updateDOM(): false {
    return false
  }

  isInline(): true {
    return true
  }

  isKeyboardSelectable(): boolean {
    return true
  }

  getChipKind(): RoutineChipKind {
    return this.__chipKind
  }

  getRefId(): string {
    return this.__refId
  }

  getChipOp(): RoutineFieldGuardOp | null {
    return this.__op
  }

  getChipValue(): RoutineFieldGuardValue | null {
    return this.__value
  }

  getChipValues(): RoutineFieldGuardValue[] | null {
    return this.__values
  }

  getChipUnit(): RoutineFieldGuardUnit | null {
    return this.__unit
  }

  getChipCounterLimit(): number | null {
    return this.__counterLimit
  }

  getSkillBindingState(): RoutineSkillBindingState {
    return {
      inputBindings: this.__inputBindings,
      outputAssignments: this.__outputAssignments,
      mode: this.__mode ?? 'typed',
    }
  }

  getInputBindings(): Record<string, RoutineInputBinding> {
    return this.__inputBindings
  }

  getOutputAssignments(): Record<string, string> {
    return this.__outputAssignments
  }

  getMode(): RoutineStepMode | null {
    return this.__mode
  }

  setSkillBindingState(next: RoutineSkillBindingState): void {
    const writable = this.getWritable()
    writable.__inputBindings = next.inputBindings ?? {}
    writable.__outputAssignments = next.outputAssignments ?? {}
    writable.__mode = next.mode ?? 'typed'
  }

  getApprovalState(): ApprovalChipState {
    return { captureKey: this.__captureKey ?? '', options: this.__options }
  }

  getCaptureKey(): string | null {
    return this.__captureKey
  }

  getApprovalOptions(): ApprovalDocOption[] {
    return this.__options
  }

  setApprovalState(next: ApprovalChipState): void {
    const writable = this.getWritable()
    writable.__captureKey = next.captureKey || null
    writable.__options = next.options
    // Keep the chip's ref id in step with the capture key so a removed/renamed gate reads
    // sensibly in the serialized block.
    writable.__refId = next.captureKey || writable.__refId
  }

  // What a serialized line contributes to `$serializeBlocks` (the compile path): a variable
  // becomes the {{slot.x}} wire form; all other chips are structural and contribute no
  // readable text — their metadata is captured separately. Clipboard copy does NOT go
  // through here; it serializes the tree to canonical tokens in the editor's copy handler.
  getTextContent(): string {
    if (this.__chipKind === 'variable') return `{{slot.${this.__refId}}}`
    return ''
  }

  decorate(): JSX.Element {
    // A step (jump) chip surfaces its loop bound on the face so a backward jump reads as
    // "go to X · max N". An approval chip renders its own conditional-prose block in ChipMenu.
    let label = this.__label
    if (this.__chipKind === 'step' && this.__counterLimit != null) {
      label = `${this.__label} · max ${this.__counterLimit}`
    }
    return <ChipMenu nodeKey={this.getKey()} kind={this.__chipKind} refId={this.__refId} label={label} />
  }
}

export function $createChipNode(chipKind: RoutineChipKind, refId: string, label: string, bindingState: RoutineSkillBindingState = {}): ChipNode {
  return new ChipNode(
    chipKind,
    refId,
    label,
    undefined,
    null,
    null,
    null,
    null,
    null,
    bindingState.inputBindings ?? {},
    bindingState.outputAssignments ?? {},
    bindingState.mode ?? null,
  )
}

// A jump (`step`) chip targets another step by its stable id; a counter limit makes it a
// bounded backward loop (the bound the runtime + validator require on a back-edge).
export function $createStepChipNode(refId: string, label: string, counterLimit: number | null = null): ChipNode {
  return new ChipNode('step', refId, label, undefined, null, null, null, null, counterLimit)
}

// An approval chip carries the whole gate: the capture slot plus the options (each routed
// to a step/terminal). It compiles to an `approval` step with one field guard per option.
export function $createApprovalChipNode(captureKey: string, options: ApprovalDocOption[]): ChipNode {
  return new ChipNode('approval', captureKey || 'decision', 'approval', undefined, null, null, null, null, null, {}, {}, null, captureKey || null, options)
}

// An inline decision declaration chip: the capture slot + the choices (labels), but no
// targets — routing is authored on the branch lines that follow it. Compiles to the same
// `approval` step the block chip does; the branches become the decision field guards.
export function $createDecisionChipNode(captureKey: string, options: ApprovalDocOption[]): ChipNode {
  return new ChipNode('decision', captureKey || 'decision', 'decision', undefined, null, null, null, null, null, {}, {}, null, captureKey || null, options)
}

export function $createConditionChipNode(
  refId: string,
  op: RoutineFieldGuardOp,
  label: string,
  value: RoutineFieldGuardValue | null,
  values: RoutineFieldGuardValue[] | null,
  unit: RoutineFieldGuardUnit | null,
): ChipNode {
  return new ChipNode('condition', refId, label, undefined, op, value, values, unit)
}

// A decided-by-AI condition chip: no operator, just the comparison phrase (held in `value`
// and shown as the label). Compiles to an `llm` guard; togglable to a decided-in-code chip.
export function $createAiConditionChipNode(phrase: string): ChipNode {
  return new ChipNode('condition', '', phrase, undefined, null, phrase)
}

export function $isChipNode(node: LexicalNode | null | undefined): node is ChipNode {
  return node instanceof ChipNode
}
