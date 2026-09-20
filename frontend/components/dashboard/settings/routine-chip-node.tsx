'use client'

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { AlertTriangle, ChevronDown, Plus, Trash2 } from 'lucide-react'
import {
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  mergeRegister,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import { $isHeadingNode } from '@lexical/rich-text'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection'

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
import { OUTCOME_GUARD_REF, ROUTINE_SLOT_TYPES, SLOT_FILLED_GUARD_REF, slugifyVariableKey, type ApprovalDocOption, type RoutineInputBinding, type RoutineSkillBindingState, type RoutineStepMode } from '@/lib/routine-prose'

import { useRoutineVariables } from '@/components/dashboard/settings/routine-variables-context'

// A chip is an atomic inline reference the author picks instead of typing raw syntax.
// Each kind renders with its own colour + glyph; the kind/type/comparison live as
// metadata on the node, never as visible syntax. A `skill` chip names a skill defined
// elsewhere (compiles to a tool step the runner dispatches through the skill port); a
// `condition` chip is a structured comparison ("decided in code"); the others are
// references/targets. An `end` chip is a branch target that completes the routine (the
// counterpart to a `handoff` chip, which escalates).
export type RoutineChipKind = 'variable' | 'skill' | 'action' | 'handoff' | 'step' | 'condition' | 'end' | 'approval' | 'decision'

type RoutineFieldGuardValue = string | number | boolean

// A branch target an approval option can route to, surfaced in the approval dialog.
type ApprovalChipTarget = { id: string; label: string }
type ApprovalChipState = { captureKey: string; options: ApprovalDocOption[] }

type SerializedChipNode = Spread<
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

// A chip reads as text with a quiet backing, not a coloured badge — kind identity comes from
// the "@" prefix and the name, the same way every kind is triggered from the same "@" menu.
// The type suffix and the dropdown caret are extra detail, shown only once the chip is
// selected or hovered so the sentence stays quiet at rest.
// `group` lets the detail spans below reveal on CSS `:hover` alone, with no mouseenter/leave
// state of our own; `alwaysShowDetails` (driven by Lexical's own selected state) overrides
// that for a chip selected by click or keyboard, which the pointer may not be over at all.
const CHIP_WRAPPER_CLASS = 'group mx-0.5 rounded-sm bg-muted/50 px-1 py-0 align-baseline text-foreground outline-none cursor-pointer hover:bg-muted'
const CHIP_SELECTED_CLASS = 'ring-1 ring-ring bg-accent text-accent-foreground'

// Strips a label's own leading "@" (only `variable` labels carry one, from how the typeahead
// seeds them) so the chip never doubles it up against the one this component always renders.
function stripAtPrefix(label: string): string {
  return label.startsWith('@') ? label.slice(1) : label
}

function ChipBadge({
  label,
  type,
  suffix,
  alwaysShowDetails,
  showCaret,
}: {
  label: string
  type: RoutineSlotType | null
  suffix?: string
  // Detail the reader doesn't need at rest: the type, any extra status text, and the caret
  // that opens the kind's own menu. Shown on hover via CSS; `alwaysShowDetails` keeps it up
  // once the chip is selected, independent of where the pointer is.
  alwaysShowDetails: boolean
  showCaret?: boolean
}): JSX.Element {
  const detailClass = alwaysShowDetails ? 'text-muted-foreground' : 'hidden text-muted-foreground group-hover:inline'
  return (
    <span className="inline-flex select-none items-baseline gap-0.5">
      <span className="text-muted-foreground">@</span>
      {stripAtPrefix(label)}
      {type ? <span className={detailClass}> · {type}</span> : null}
      {suffix ? <span className={detailClass}> · {suffix}</span> : null}
      {showCaret ? <ChevronDown className={`h-3 w-3 self-center ${alwaysShowDetails ? 'text-muted-foreground' : 'hidden text-muted-foreground group-hover:inline-block'}`} /> : null}
    </span>
  )
}

// Wires a chip into Lexical's own selection model — the pattern behind @lexical/react's
// decorator examples (`useLexicalNodeSelection` + registered commands) — instead of a click
// target with no selection state of its own. A click marks the node selected, so it renders
// with a visible selected state and Backspace/Delete/Enter act on it the way they would on
// any other selected node. Enter (and a double-click, wired at the call site) replace the chip
// with its raw `@<label>` text and reopen the typeahead at that position, so a mistyped or
// abandoned edit resolves as ordinary text instead of a broken-looking bound reference.
function useChipController(nodeKey: NodeKey) {
  const [editor] = useLexicalComposerContext()
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey)

  const select = useCallback(() => {
    clearSelection()
    setSelected(true)
  }, [clearSelection, setSelected])

  // Same focus hand-off `removeSelected` below needs, for the same reason: this also destroys
  // the DOM element that a double-click or Enter left focused (the chip's own button), and
  // doing that before anything is focused elsewhere sends focus to `document.body` — which
  // reads as leaving the field entirely and closes the row's own editing session out from
  // under this replacement.
  const convertToText = useCallback(() => {
    editor.getRootElement()?.focus()
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if (!$isChipNode(node)) return
      const raw = stripAtPrefix(node.getLabel())
      const textNode = $createTextNode(`@${raw}`)
      node.replace(textNode)
      textNode.select()
    })
  }, [editor, nodeKey])

  // Removing the selected node deletes the very DOM element that currently holds focus (the
  // chip's own button), and a browser sends focus to `document.body` — not anywhere in
  // particular — when its focused element disappears; `editor.focus()` does not reliably claim
  // it back afterward, because it only re-applies the DOM Selection range, and a browser does
  // not treat setting a Range inside an element as focusing that element. Moving focus to the
  // content-editable root before the button is actually removed sidesteps the reset entirely —
  // the button is still in the DOM at this point, so this is an ordinary focus handoff, not a
  // recovery from one.
  const removeSelected = useCallback(() => {
    const node = $getNodeByKey(nodeKey)
    if (!node) return
    const parent = node.getParent()
    const index = node.getIndexWithinParent()
    editor.getRootElement()?.focus()
    node.remove()
    parent?.select(index, index)
  }, [editor, nodeKey])

  // Reading Lexical's own live selection here — instead of gating on the `isSelected` returned
  // by the hook above — matters because that value is React state: it only reflects the
  // editor's true selection once a render has committed and this effect has re-run with a
  // fresh closure. A key can be dispatched in the gap between `select()` being called and that
  // render landing (most visibly right after a menu closes and reselects), and Lexical
  // guarantees `$getSelection()` is current at the moment a command fires regardless of where
  // React's own render cycle is.
  const isThisNodeSelected = useCallback(() => {
    const selection = $getSelection()
    return $isNodeSelection(selection) && selection.has(nodeKey)
  }, [nodeKey])

  useEffect(() => mergeRegister(
    editor.registerCommand(KEY_BACKSPACE_COMMAND, () => {
      if (!isThisNodeSelected()) return false
      removeSelected()
      return true
    }, COMMAND_PRIORITY_LOW),
    editor.registerCommand(KEY_DELETE_COMMAND, () => {
      if (!isThisNodeSelected()) return false
      removeSelected()
      return true
    }, COMMAND_PRIORITY_LOW),
    editor.registerCommand(KEY_ENTER_COMMAND, () => {
      if (!isThisNodeSelected()) return false
      convertToText()
      return true
    }, COMMAND_PRIORITY_LOW),
  ), [convertToText, editor, isThisNodeSelected, removeSelected])

  // Radix returns DOM focus to the trigger button when its menu closes, by default — which
  // fires a native focus/selectionchange event that Lexical's own listener reads as a fresh
  // caret position, clobbering the NodeSelection this hook wants restored. `onCloseAutoFocus`
  // is the right hook to cancel that default with, but it only fires once the content has
  // actually left the DOM — after this menu's own close *animation* finishes, tens to a couple
  // hundred milliseconds after the key or click that closed it. Doing the actual reselect there
  // would leave a live gap, right after closing, where a fast next keystroke (Backspace, right
  // after Escape) lands on no selection at all. `onOpenChange` fires immediately instead, so the
  // reselect happens there; `onCloseAutoFocus` is kept only to cancel Radix's own later, now
  // redundant, focus hand-off before it can re-clobber the selection this already set. A menu
  // item that opens a further surface (a dialog, a builder) sets this flag first so its own
  // focus management is not immediately overridden by this reselect.
  const suppressCloseFocusRef = useRef(false)
  const suppressNextCloseFocus = useCallback(() => {
    suppressCloseFocusRef.current = true
  }, [])
  const onMenuOpenChange = useCallback((open: boolean) => {
    if (open) return
    if (suppressCloseFocusRef.current) {
      suppressCloseFocusRef.current = false
      return
    }
    editor.getRootElement()?.focus()
    select()
  }, [editor, select])
  const onMenuCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault()
  }, [])

  return { isSelected, select, convertToText, onMenuOpenChange, onMenuCloseAutoFocus, suppressNextCloseFocus }
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

  const canConfirm = options.length >= 2
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
                disabled={options.length <= 2}
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
function ApprovalChipDialog({
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

function DecisionChipDialog({
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
function approvalChipTargets(stepTargets: ApprovalChipTarget[]): ApprovalChipTarget[] {
  return [...stepTargets, { id: 'done', label: 'End (complete)' }, { id: 'handoff', label: 'Handoff' }]
}

// Name an ending and give it its own completion message. A blank name is the default ending
// (the primary complete terminal, whose message is the header field); a name makes it an
// additional completion whose message is carried here, so a branch can finish with its own copy.
function EndDialog({
  open,
  onOpenChange,
  initialName,
  initialMessage,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialName: string
  initialMessage: string
  onConfirm: (name: string, message: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [message, setMessage] = useState(initialMessage)
  // A named ending becomes a terminal id, so it can't reuse the reserved `done`/`handoff` refs —
  // that would collide with the default completion or the handoff terminal. (The backend
  // validator also rejects any id shared by two nodes, covering collisions with step ids.)
  const reservedCollision = name.trim().length > 0 && (slugifyVariableKey(name.trim()) === 'done' || slugifyVariableKey(name.trim()) === 'handoff')
  const confirm = () => {
    if (reservedCollision) return
    onConfirm(name, message)
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ending</DialogTitle>
          <DialogDescription>Leave the name blank for the routine&apos;s default ending. Give it a name to add a separate ending with its own completion message.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="endName">Ending name (optional)</Label>
            <Input id="endName" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. ineligible" />
            {reservedCollision ? (
              <p className="text-xs text-destructive">That name is reserved — pick a different name for this ending.</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="endMessage">Completion message (optional)</Label>
            <Input id="endMessage" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="What the agent says at this ending" />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" onClick={confirm} disabled={reservedCollision}>Save ending</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChipMenu({ nodeKey, kind, refId, label }: { nodeKey: NodeKey; kind: RoutineChipKind; refId: string; label: string }): JSX.Element {
  const [editor] = useLexicalComposerContext()
  const { isSelected, select, convertToText, onMenuOpenChange, onMenuCloseAutoFocus, suppressNextCloseFocus } = useChipController(nodeKey)
  const { getType, setType, getRequired, setRequired, getMutable, setMutable, variables, supportsStepBindings } = useRoutineVariables()
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

  // Demote a decided-in-code check to decided-by-AI: replace the structured rule with a bare
  // AI⇄code selector chip and seed the branch line's free text with the humanized comparison
  // (e.g. "customer_age is at least 18"), so the author keeps editing words — not a frozen
  // chip. The selector keeps it togglable back to decided-in-code (issue: "once decided by AI,
  // can't go back"); the fluid text keeps the phrase editable. Compiles to an `llm` guard.
  const demoteToAi = () => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if (!node) return
      const selector = $createAiConditionChipNode()
      node.replace(selector)
      if (label.trim()) selector.insertAfter($createTextNode(label.trim()))
    })
  }

  // Promote a decided-by-AI condition to decided-in-code: the structured comparison from the
  // builder replaces the selector chip, producing a deterministic field guard. The old AI
  // phrase is the branch line's free text; drop it (a branch line's only text is that phrase)
  // so the structured comparison isn't shadowed by a stale duplicate.
  const promoteToCode = (condition: ConditionDraft) => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if (!node) return
      const parent = node.getParent()
      node.replace($createConditionChipNode(condition.refId, condition.op, condition.label, condition.value, condition.values, condition.unit))
      if (parent) {
        for (const child of parent.getChildren()) {
          if (!$isChipNode(child)) child.remove()
        }
      }
    })
  }

  const removeSelf = () => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      node?.remove()
    })
  }

  const [isEndOpen, setIsEndOpen] = useState(false)
  // The current ending's completion message — a named end carries its own copy in `value`.
  const readEndMessage = (): string => {
    let message = ''
    editor.getEditorState().read(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isChipNode(node)) {
        const value = node.getChipValue()
        if (typeof value === 'string') message = value
      }
    })
    return message
  }
  // Replace this end chip per the dialog. A blank name resets it to the default ending (the
  // primary complete, refId `done`, message in the header); a name makes it a separate ending
  // whose message rides on the chip.
  const applyEnding = (name: string, message: string) => {
    const trimmedName = name.trim()
    const trimmedMessage = message.trim()
    const nextRefId = trimmedName ? slugifyVariableKey(trimmedName) : 'done'
    const nextLabel = trimmedName ? nextRefId : 'end'
    const value = nextRefId !== 'done' && trimmedMessage ? trimmedMessage : null
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      node?.replace($createEndChipNode(nextRefId, value, nextLabel))
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
          className={`${CHIP_WRAPPER_CLASS} ${isSelected ? CHIP_SELECTED_CLASS : ''}`}
          onClick={() => { select(); setIsDecisionOpen(true) }}
          onDoubleClick={convertToText}
        >
          <span className="text-muted-foreground">@</span>
          {initial.captureKey && initial.captureKey !== 'decision' ? initial.captureKey : 'decision'}
          {choices ? <span className="text-muted-foreground"> · {choices}</span> : null}
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
          className={`${CHIP_WRAPPER_CLASS} inline-flex flex-col gap-0.5 py-1 text-left ${isSelected ? CHIP_SELECTED_CLASS : ''}`}
          onClick={() => { select(); setIsApprovalOpen(true) }}
        >
          <span className="inline-flex items-center gap-1">
            <span className="text-muted-foreground">@</span>
            Approval — a person chooses:
            {initial.captureKey && initial.captureKey !== 'decision'
              ? <span className="text-muted-foreground"> · records {initial.captureKey}</span>
              : null}
          </span>
          {initial.options.length === 0 ? (
            <span className="text-muted-foreground">no choices yet — click to add</span>
          ) : (
            initial.options.map((option, index) => (
              <span key={index}>
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
        // Outside a routine there is no step to bind, so the popover names the skill instead
        // of offering input/output wiring that has nowhere to land.
        showStepBindings={supportsStepBindings}
        availableVariables={supportsStepBindings ? variables.map((variable) => variable.id) : []}
        open={isCatalogOpen}
        onOpenChange={handleCatalogOpenChange}
        onBindingStateChange={updateDraftBindingState}
        onRemove={removeSelf}
      >
        <button
          type="button"
          contentEditable={false}
          data-routine-chip={kind}
          className={`${CHIP_WRAPPER_CLASS} inline-flex items-center gap-1 ${isSelected ? CHIP_SELECTED_CLASS : ''}`}
          onClick={select}
          onDoubleClick={convertToText}
        >
          {/* An unknown skill is a data-integrity warning, not a kind's own colour — it keeps
              its triangle so a broken reference stays visible even in the quiet treatment. */}
          {isUnknownSkill ? <AlertTriangle className="h-3 w-3 text-amber-600 dark:text-amber-400" /> : null}
          <ChipBadge
            label={isUnknownSkill ? label : resolvedLabel}
            type={type}
            suffix={isUnknownSkill ? 'unknown skill' : undefined}
            alwaysShowDetails={isSelected}
          />
        </button>
      </RoutineSkillCatalogPopover>
    )
  }

  if (kind === 'condition' && refId === OUTCOME_GUARD_REF) {
    // An outcome guard branches on the preceding tool step's result status. It is neither a
    // decided-in-code rule nor an AI phrase, so it shows its own badge and only offers Remove.
    return (
      <DropdownMenu modal={false} onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            contentEditable={false}
            data-routine-chip={kind}
            data-guard-mode="outcome"
            className={`${CHIP_WRAPPER_CLASS} ${isSelected ? CHIP_SELECTED_CLASS : ''}`}
            onClick={select}
            onDoubleClick={convertToText}
          >
            <ChipBadge label={label} type={null} suffix="outcome" alwaysShowDetails={isSelected} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={onMenuCloseAutoFocus}>
          <DropdownMenuLabel>Branch on the skill outcome</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={removeSelf}>Remove</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  if (kind === 'condition' && refId === SLOT_FILLED_GUARD_REF) {
    // A slot-filled guard continues once the named slots are present. Like the outcome guard it
    // is neither a decided-in-code rule nor an AI phrase, so it shows its own badge and only
    // offers Remove.
    return (
      <DropdownMenu modal={false} onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            contentEditable={false}
            data-routine-chip={kind}
            data-guard-mode="slot-filled"
            className={`${CHIP_WRAPPER_CLASS} ${isSelected ? CHIP_SELECTED_CLASS : ''}`}
            onClick={select}
            onDoubleClick={convertToText}
          >
            <ChipBadge label={label} type={null} suffix="when filled" alwaysShowDetails={isSelected} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={onMenuCloseAutoFocus}>
          <DropdownMenuLabel>Continue once slots are provided</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={removeSelf}>Remove</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
        <DropdownMenu modal={false} onOpenChange={onMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              contentEditable={false}
              data-routine-chip={kind}
              data-guard-mode={isAi ? 'ai' : 'code'}
              className={`${CHIP_WRAPPER_CLASS} ${isSelected ? CHIP_SELECTED_CLASS : ''}`}
              onClick={select}
              onDoubleClick={convertToText}
            >
              <ChipBadge label={isAi ? 'AI decides' : label} type={null} suffix={isAi ? undefined : 'rule'} alwaysShowDetails={isSelected} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={onMenuCloseAutoFocus}>
            <DropdownMenuLabel>{isAi ? 'Decided by AI' : 'Decided in code'}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {isAi ? (
              <DropdownMenuItem onClick={() => { suppressNextCloseFocus(); setIsConditionBuilderOpen(true) }}>Switch to decided in code</DropdownMenuItem>
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
    <>
    <DropdownMenu modal={false} onOpenChange={onMenuOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          contentEditable={false}
          data-routine-chip={kind}
          data-end-named={kind === 'end' && refId !== 'done' ? 'true' : undefined}
          className={`${CHIP_WRAPPER_CLASS} ${isSelected ? CHIP_SELECTED_CLASS : ''}`}
          onClick={select}
          onDoubleClick={convertToText}
        >
          <ChipBadge
            label={label}
            type={type}
            suffix={kind === 'end' && refId !== 'done' ? 'ending' : undefined}
            alwaysShowDetails={isSelected}
            showCaret={kind === 'variable'}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44" onCloseAutoFocus={onMenuCloseAutoFocus}>
        {kind === 'end' ? (
          <>
            <DropdownMenuItem onClick={() => { suppressNextCloseFocus(); setIsEndOpen(true) }}>Name &amp; message…</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {kind === 'variable' ? (
          <>
            <DropdownMenuLabel>Variable type</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={getType(refId)} onValueChange={(value) => setType(refId, value as RoutineSlotType)}>
              {ROUTINE_SLOT_TYPES.map((type) => (
                <DropdownMenuRadioItem key={type} value={type}>{type}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            {/* Closing the menu on select would drop the author mid-config; keep it open so
                type, optional, and editable can be toggled in one pass. */}
            <DropdownMenuCheckboxItem
              checked={!getRequired(refId)}
              onCheckedChange={(checked) => setRequired(refId, !checked)}
              onSelect={(event) => event.preventDefault()}
            >
              Optional
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={getMutable(refId)}
              onCheckedChange={(checked) => setMutable(refId, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              Editable after completion
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onClick={removeSelf}>Remove</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {kind === 'end' ? (
      <EndDialog
        open={isEndOpen}
        onOpenChange={setIsEndOpen}
        initialName={refId !== 'done' ? refId : ''}
        initialMessage={readEndMessage()}
        onConfirm={applyEnding}
      />
    ) : null}
    </>
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

  getLabel(): string {
    return this.__label
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

// A decided-by-AI condition chip: a bare AI⇄code selector with no operator and no phrase
// payload — the comparison phrase lives as ordinary editable text beside it on the branch
// line. Compiles to an `llm` guard (that adjacent prose is the guard text); togglable to a
// decided-in-code chip.
export function $createAiConditionChipNode(): ChipNode {
  return new ChipNode('condition', '', '', undefined, null, null)
}

// An `end` chip completes the routine. The default ending targets the primary complete terminal
// (its message is the header field). A named ending (a distinct id) is an additional completion
// whose message rides on the chip's `value`, so the extra ending survives the prose round-trip.
export function $createEndChipNode(refId: string, message: string | null, label: string): ChipNode {
  return new ChipNode('end', refId, label, undefined, null, message)
}

// An outcome guard chip: a condition that branches on the preceding tool step's result
// status (held in `value`). The sentinel refId marks it as a step-result branch rather than
// a variable comparison; it compiles to an `outcome` guard.
export function $createOutcomeConditionChipNode(status: string): ChipNode {
  const trimmed = status.trim()
  return new ChipNode('condition', OUTCOME_GUARD_REF, `outcome is ${trimmed}`, undefined, null, trimmed)
}

// A slot-filled guard chip: a condition that continues once the named slots are present. The
// sentinel refId marks it as a slot-presence gate; the slot keys ride in `values`. Compiles to
// a `slot_filled` guard.
export function $createSlotFilledConditionChipNode(keys: string[], label: string): ChipNode {
  return new ChipNode('condition', SLOT_FILLED_GUARD_REF, label, undefined, null, null, keys, null)
}

export function $isChipNode(node: LexicalNode | null | undefined): node is ChipNode {
  return node instanceof ChipNode
}
