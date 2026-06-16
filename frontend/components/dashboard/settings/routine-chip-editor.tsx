'use client'

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { AtSign, BadgeCheck, Bold, CornerUpRight, Flag, Heading1, Italic } from 'lucide-react'

import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
} from '@lexical/react/LexicalTypeaheadMenuPlugin'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type EditorState,
  type TextNode,
} from 'lexical'

import { $createHeadingNode, $isHeadingNode, HeadingNode } from '@lexical/rich-text'

import { $createChipNode, $createConditionChipNode, $createStepChipNode, $isChipNode, ChipNode, type RoutineChipKind } from '@/components/dashboard/settings/routine-chip-node'
import { RoutineVariablesProvider } from '@/components/dashboard/settings/routine-variables-context'
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
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { RoutineFieldGuardOp, RoutineFieldGuardUnit, RoutineSlotType } from '@/lib/api-types'
import {
  fieldGuardOpLabel,
  fieldGuardOpNeedsUnit,
  fieldGuardOpNeedsValue,
  fieldGuardOpsForType,
  formatConditionLabel,
  ROUTINE_FIELD_GUARD_UNITS,
  ROUTINE_SLOT_TYPES,
  slugifyVariableKey,
  type ChipDocVariable,
  type ProseParagraph,
  type RoutineDocBlock,
  type RoutineFieldGuardValue,
} from '@/lib/routine-prose'

export type RoutineEditorVariable = { id: string; name: string }

class ChipMenuOption extends MenuOption {
  display: string
  kind: RoutineChipKind
  isNew: boolean
  refId: string
  name: string

  constructor(key: string, data: { display: string; kind: RoutineChipKind; isNew: boolean; refId: string; name: string }) {
    super(key)
    this.display = data.display
    this.kind = data.kind
    this.isNew = data.isNew
    this.refId = data.refId
    this.name = data.name
  }
}

type ConditionDraft = {
  refId: string
  op: RoutineFieldGuardOp
  label: string
  value: RoutineFieldGuardValue | null
  values: RoutineFieldGuardValue[] | null
  unit: RoutineFieldGuardUnit | null
}

function ConditionBuilderDialog({
  open,
  onOpenChange,
  variables,
  onConfirm,
  onSetVariableType,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  variables: ChipDocVariable[]
  onConfirm: (condition: ConditionDraft) => void
  onSetVariableType: (refId: string, type: RoutineSlotType) => void
}) {
  const [refId, setRefId] = useState('')
  const [op, setOp] = useState<RoutineFieldGuardOp>('equals')
  const [valueText, setValueText] = useState('')
  const [unit, setUnit] = useState<RoutineFieldGuardUnit>('months')
  const selected = variables.find((variable) => variable.id === refId)
  const ops = selected ? fieldGuardOpsForType(selected.type) : []
  const needsValue = fieldGuardOpNeedsValue(op)
  const needsUnit = fieldGuardOpNeedsUnit(op)

  const reset = () => {
    setRefId('')
    setOp('equals')
    setValueText('')
    setUnit('months')
  }

  const confirm = () => {
    if (!selected) return
    const numeric = needsUnit || selected.type === 'number'
    const coerce = (raw: string): RoutineFieldGuardValue =>
      numeric && raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw
    const value = needsValue && op !== 'in' ? coerce(valueText.trim()) : null
    const values = needsValue && op === 'in'
      ? valueText.split(',').map((part) => part.trim()).filter((part) => part !== '').map(coerce)
      : null
    const unitValue = needsUnit ? unit : null
    onConfirm({ refId: selected.id, op, label: formatConditionLabel(selected.name, op, value, values, unitValue), value, values, unit: unitValue })
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a check</DialogTitle>
          <DialogDescription>Branch on a variable with an exact comparison — decided in code, not by the AI.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="conditionVariable">Variable</Label>
            <select
              id="conditionVariable"
              value={refId}
              onChange={(event) => {
                const next = event.target.value
                setRefId(next)
                const variable = variables.find((candidate) => candidate.id === next)
                if (variable) setOp(fieldGuardOpsForType(variable.type)[0]!)
              }}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Choose a variable…</option>
              {variables.map((variable) => (
                <option key={variable.id} value={variable.id}>{variable.name}</option>
              ))}
            </select>
          </div>
          {selected ? (
            <div className="space-y-1.5">
              <Label htmlFor="conditionType">Type</Label>
              <select
                id="conditionType"
                value={selected.type}
                onChange={(event) => {
                  const nextType = event.target.value as RoutineSlotType
                  onSetVariableType(selected.id, nextType)
                  setOp(fieldGuardOpsForType(nextType)[0]!)
                }}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {ROUTINE_SLOT_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">The type decides which exact checks are available.</p>
            </div>
          ) : null}
          {selected ? (
            <div className="space-y-1.5">
              <Label htmlFor="conditionOp">Check</Label>
              <select
                id="conditionOp"
                value={op}
                onChange={(event) => setOp(event.target.value as RoutineFieldGuardOp)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {ops.map((candidate) => (
                  <option key={candidate} value={candidate}>{fieldGuardOpLabel(candidate)}</option>
                ))}
              </select>
            </div>
          ) : null}
          {selected && needsValue ? (
            <div className="space-y-1.5">
              <Label htmlFor="conditionValue">{op === 'in' ? 'Values (comma-separated)' : needsUnit ? 'Amount' : 'Value'}</Label>
              <Input
                id="conditionValue"
                value={valueText}
                onChange={(event) => setValueText(event.target.value)}
                placeholder={op === 'in' ? 'completed, refunded' : needsUnit ? '6' : 'completed'}
              />
            </div>
          ) : null}
          {selected && needsUnit ? (
            <div className="space-y-1.5">
              <Label htmlFor="conditionUnit">Unit</Label>
              <select
                id="conditionUnit"
                value={unit}
                onChange={(event) => setUnit(event.target.value as RoutineFieldGuardUnit)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {ROUTINE_FIELD_GUARD_UNITS.map((candidate) => (
                  <option key={candidate} value={candidate}>{candidate}</option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" onClick={confirm} disabled={!selected || (needsValue && !valueText.trim())}>
            Add check
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Insert a jump to a named step. A jump back to an earlier step is a loop, so it must be
// capped — the limit compiles to a counter guard (the bound the runtime + validator need).
function JumpDialog({
  open,
  onOpenChange,
  targets,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  targets: { id: string; title: string }[]
  onConfirm: (target: { id: string; title: string }, counterLimit: number | null) => void
}) {
  const [targetId, setTargetId] = useState('')
  const [loop, setLoop] = useState(false)
  const [maxText, setMaxText] = useState('3')
  const selected = targets.find((target) => target.id === targetId)

  const reset = () => { setTargetId(''); setLoop(false); setMaxText('3') }
  const confirm = () => {
    if (!selected) return
    const limit = loop ? Math.max(1, Number.parseInt(maxText, 10) || 0) : null
    onConfirm(selected, limit)
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Jump to a step</DialogTitle>
          <DialogDescription>Send the routine to another named step. A jump back to an earlier step is a loop — cap how many times it can repeat so it always ends.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="jumpTarget">Step</Label>
            <select
              id="jumpTarget"
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Choose a step…</option>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>{target.title}</option>
              ))}
            </select>
            {targets.length === 0 ? (
              <p className="text-xs text-muted-foreground">Give a step a title first (the Step button) so a jump can target it.</p>
            ) : null}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />
            Loop back (repeat a limited number of times)
          </label>
          {loop ? (
            <div className="space-y-1.5">
              <Label htmlFor="jumpMax">Max times</Label>
              <Input id="jumpMax" type="number" min={1} value={maxText} onChange={(event) => setMaxText(event.target.value)} />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" onClick={confirm} disabled={!selected}>Add jump</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// A clearly visible "on" state for the toggle buttons (Bold/Italic/Step). The default
// `secondary` button variant is a washed-out grey that reads as inactive against the
// toolbar, so an active toggle gets the solid accent instead.
const ACTIVE_TOOLBAR_BUTTON = 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'

function EditorToolbar({ variables, onSetVariableType }: { variables: ChipDocVariable[]; onSetVariableType: (refId: string, type: RoutineSlotType) => void }) {
  const [editor] = useLexicalComposerContext()
  const [conditionOpen, setConditionOpen] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [jumpTargets, setJumpTargets] = useState<{ id: string; title: string }[]>([])
  const [formats, setFormats] = useState({ bold: false, italic: false, step: false })

  // Track the caret's active formats so Bold/Italic/Step show their pressed state. `step`
  // is whether the caret's line is a titled step (an h1 heading).
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) {
          const block = selection.anchor.getNode().getTopLevelElement()
          setFormats({
            bold: selection.hasFormat('bold'),
            italic: selection.hasFormat('italic'),
            step: !!block && $isHeadingNode(block),
          })
        }
      })
    })
  }, [editor])

  const insertVariableTrigger = () => {
    editor.focus(() => {
      editor.update(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) {
          selection.insertText('@')
        }
      })
    })
  }

  const insertCondition = (condition: ConditionDraft) => {
    editor.focus(() => {
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return
        const chip = $createConditionChipNode(condition.refId, condition.op, condition.label, condition.value, condition.values, condition.unit)
        selection.insertNodes([chip])
        const trailing = $createTextNode(' ')
        chip.insertAfter(trailing)
        trailing.select()
      })
    })
  }

  // Insert an end chip — a branch target that completes the routine (the counterpart to a
  // handoff). The line's prose / condition chip is the guard that decides the branch.
  const insertEnd = () => {
    editor.focus(() => {
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return
        const chip = $createChipNode('end', 'done', 'end')
        selection.insertNodes([chip])
        const trailing = $createTextNode(' ')
        chip.insertAfter(trailing)
        trailing.select()
      })
    })
  }

  // Toggle the current line between a step title (h1) and ordinary prose. A titled step
  // gets a stable id, so a jump can target it by name; toggling it off turns it back into
  // body text. Mirrors how Bold/Italic toggle.
  const toggleLineStep = () => {
    editor.focus(() => {
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return
        const block = selection.anchor.getNode().getTopLevelElement()
        if (!block) return
        const replacement = $isHeadingNode(block) ? $createParagraphNode() : $createHeadingNode('h1')
        for (const child of block.getChildren()) replacement.append(child)
        block.replace(replacement)
        replacement.selectEnd()
      })
    })
  }

  // The jump targets are the titled steps (h1 headings) currently in the document.
  const openJump = () => {
    const targets: { id: string; title: string }[] = []
    editor.getEditorState().read(() => {
      for (const block of $getRoot().getChildren()) {
        if ($isHeadingNode(block)) {
          const title = block.getTextContent().trim()
          if (title) targets.push({ id: slugifyVariableKey(title), title })
        }
      }
    })
    setJumpTargets(targets)
    setJumpOpen(true)
  }

  const insertJump = (target: { id: string; title: string }, counterLimit: number | null) => {
    editor.focus(() => {
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return
        const chip = $createStepChipNode(target.id, target.title, counterLimit)
        selection.insertNodes([chip])
        const trailing = $createTextNode(' ')
        chip.insertAfter(trailing)
        trailing.select()
      })
    })
  }

  return (
    <div className="flex items-center gap-0.5 border-b border-input px-1.5 py-1">
      <Button type="button" variant="ghost" size="sm" className={cn('h-7 w-7 p-0', formats.bold && ACTIVE_TOOLBAR_BUTTON)} aria-label="Bold" aria-pressed={formats.bold} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}>
        <Bold className="h-4 w-4" />
      </Button>
      <Button type="button" variant="ghost" size="sm" className={cn('h-7 w-7 p-0', formats.italic && ACTIVE_TOOLBAR_BUTTON)} aria-label="Italic" aria-pressed={formats.italic} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}>
        <Italic className="h-4 w-4" />
      </Button>
      <Separator orientation="vertical" className="mx-1 h-5" />
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={insertVariableTrigger}>
        <AtSign className="h-4 w-4" />
        Variable
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => setConditionOpen(true)} disabled={variables.length === 0}>
        <BadgeCheck className="h-4 w-4" />
        Condition
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={insertEnd}>
        <Flag className="h-4 w-4" />
        End
      </Button>
      <Separator orientation="vertical" className="mx-1 h-5" />
      <Button type="button" variant="ghost" size="sm" className={cn('h-7 gap-1 px-2', formats.step && ACTIVE_TOOLBAR_BUTTON)} aria-pressed={formats.step} onClick={toggleLineStep}>
        <Heading1 className="h-4 w-4" />
        Step
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={openJump}>
        <CornerUpRight className="h-4 w-4" />
        Jump
      </Button>
      <ConditionBuilderDialog open={conditionOpen} onOpenChange={setConditionOpen} variables={variables} onConfirm={insertCondition} onSetVariableType={onSetVariableType} />
      <JumpDialog open={jumpOpen} onOpenChange={setJumpOpen} targets={jumpTargets} onConfirm={insertJump} />
    </div>
  )
}

function ChipTypeaheadPlugin({
  variables,
  reservedRefKinds,
  onCreateVariable,
}: {
  variables: RoutineEditorVariable[]
  reservedRefKinds: Record<string, RoutineChipKind>
  onCreateVariable: (variable: RoutineEditorVariable) => void
}) {
  const [editor] = useLexicalComposerContext()
  const [query, setQuery] = useState<string | null>(null)
  // Custom trigger so variable names with underscores keep the menu open (the default
  // matcher treats "_" as a word boundary and cancels the popover).
  const triggerFn = useCallback((text: string) => {
    const match = /(^|\s|\()@([A-Za-z0-9_-]*)$/.exec(text)
    if (match === null) return null
    const leading = match[1] ?? ''
    const matchingString = match[2] ?? ''
    return {
      leadOffset: match.index + leading.length,
      matchingString,
      replaceableString: `@${matchingString}`,
    }
  }, [])

  const options = useMemo<ChipMenuOption[]>(() => {
    const raw = (query ?? '').trim()
    const lowered = raw.toLowerCase()
    const result: ChipMenuOption[] = variables
      .filter((variable) => !lowered || variable.name.toLowerCase().includes(lowered))
      .map((variable) => new ChipMenuOption(`var-${variable.id}`, {
        display: `@${variable.name}`,
        kind: 'variable',
        isNew: false,
        refId: variable.id,
        name: variable.name,
      }))
    if (raw) {
      // A name identifies one thing: once it's used by a chip, don't offer to
      // create a different kind with the same name (so a variable and an action
      // can't both be "test"). The existing chip of that kind stays reusable.
      const refId = slugifyVariableKey(raw)
      const reservedKind = reservedRefKinds[refId]
      const canCreate = (kind: RoutineChipKind) => !reservedKind || reservedKind === kind
      if (!variables.some((variable) => variable.name.toLowerCase() === lowered) && canCreate('variable')) {
        result.push(new ChipMenuOption(`new-variable-${lowered}`, {
          display: `Create variable “${raw}”`,
          kind: 'variable',
          isNew: true,
          refId,
          name: raw,
        }))
      }
      if (canCreate('skill')) {
        result.push(new ChipMenuOption(`new-skill-${lowered}`, {
          display: `Skill: ${raw}`,
          kind: 'skill',
          isNew: true,
          refId,
          name: raw,
        }))
      }
      if (canCreate('handoff')) {
        result.push(new ChipMenuOption(`new-handoff-${lowered}`, {
          display: `Handoff: ${raw}`,
          kind: 'handoff',
          isNew: true,
          refId,
          name: raw,
        }))
      }
    }
    return result.slice(0, 8)
  }, [variables, reservedRefKinds, query])

  const onSelectOption = useCallback(
    (option: ChipMenuOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        if (option.kind === 'variable' && option.isNew) {
          onCreateVariable({ id: option.refId, name: option.name })
        }
        const label = option.kind === 'variable' ? `@${option.name}` : option.name
        const chip = $createChipNode(option.kind, option.refId, label)
        if (nodeToReplace) {
          nodeToReplace.replace(chip)
        }
        const trailing = $createTextNode(' ')
        chip.insertAfter(trailing)
        trailing.select()
        closeMenu()
      })
    },
    [editor, onCreateVariable],
  )

  return (
    <LexicalTypeaheadMenuPlugin<ChipMenuOption>
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      triggerFn={triggerFn}
      options={options}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorElementRef.current && options.length > 0
          ? createPortal(
              <ul
                className="z-50 max-h-60 min-w-52 overflow-auto rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
                role="listbox"
                aria-label="Insert a chip"
              >
                {options.map((option, index) => (
                  <li
                    key={option.key}
                    role="option"
                    aria-selected={selectedIndex === index}
                    className={`cursor-pointer rounded-sm px-2 py-1.5 ${selectedIndex === index ? 'bg-accent text-accent-foreground' : ''}`}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      selectOptionAndCleanUp(option)
                    }}
                  >
                    {option.display}
                  </li>
                ))}
              </ul>,
              anchorElementRef.current,
            )
          : null
      }
    />
  )
}

// The editor is the single source of document serialization: read the live tree into
// the flat {text, chips} blocks the host compiles. Used by the change handler and the
// on-mount emit (so a loaded document seeds the host's draft without a second encoder).
function $serializeBlocks(): RoutineDocBlock[] {
  return $getRoot().getChildren().map((block) => ({
    // An h1 heading names a step; the compiler reads headingLevel to pin a stable id.
    ...($isHeadingNode(block) ? { headingLevel: 1 as const } : {}),
    text: block.getTextContent(),
    chips: $isElementNode(block)
      ? block.getChildren().filter($isChipNode).map((chip) => ({
          kind: chip.getChipKind() as string,
          refId: chip.getRefId(),
          op: chip.getChipOp(),
          value: chip.getChipValue(),
          values: chip.getChipValues(),
          unit: chip.getChipUnit(),
          counterLimit: chip.getChipCounterLimit(),
        }))
      : [],
  }))
}

// Build the editor's initial document from loaded prose paragraphs (a variable becomes a
// chip, condition/handoff chips carry their metadata, everything else is literal text).
function $initializeFromParagraphs(paragraphs: ProseParagraph[]): void {
  const root = $getRoot()
  if (root.getChildrenSize() > 0) return
  for (const paragraph of paragraphs) {
    const node = paragraph.headingLevel === 1 ? $createHeadingNode('h1') : $createParagraphNode()
    for (const segment of paragraph.segments) {
      if (segment.kind === 'text') {
        node.append($createTextNode(segment.text))
      } else if (segment.chipKind === 'condition' && segment.op) {
        node.append($createConditionChipNode(segment.refId, segment.op, segment.label, segment.value ?? null, segment.values ?? null, segment.unit ?? null))
      } else if (segment.chipKind === 'step') {
        node.append($createStepChipNode(segment.refId, segment.label, segment.counterLimit ?? null))
      } else {
        node.append($createChipNode(segment.chipKind, segment.refId, segment.label))
      }
    }
    root.append(node)
  }
}

function OnDocChangePlugin({ onDocChange }: { onDocChange: (blocks: RoutineDocBlock[]) => void }) {
  const [editor] = useLexicalComposerContext()
  // Emit the initial (possibly loaded) document once so the host seeds its draft from
  // exactly what the editor parsed — Lexical's change handler ignores the initial state.
  useEffect(() => {
    editor.getEditorState().read(() => onDocChange($serializeBlocks()))
  }, [editor, onDocChange])
  return <OnChangePlugin onChange={(editorState: EditorState) => editorState.read(() => onDocChange($serializeBlocks()))} />
}

export function RoutineChipEditor({
  variables,
  reservedRefKinds,
  initialContent,
  onCreateVariable,
  onDocChange,
  onSetVariableType,
}: {
  variables: ChipDocVariable[]
  reservedRefKinds: Record<string, RoutineChipKind>
  initialContent?: ProseParagraph[]
  onCreateVariable: (variable: RoutineEditorVariable) => void
  onDocChange: (blocks: RoutineDocBlock[]) => void
  onSetVariableType: (refId: string, type: RoutineSlotType) => void
}): JSX.Element {
  const variablesContext = useMemo(
    () => ({
      getType: (refId: string): RoutineSlotType => variables.find((variable) => variable.id === refId)?.type ?? 'text',
      setType: onSetVariableType,
    }),
    [variables, onSetVariableType],
  )

  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'routine-chip-editor',
        nodes: [ChipNode, HeadingNode],
        onError: (error: Error) => {
          throw error
        },
        theme: {},
        editorState: initialContent && initialContent.length > 0
          ? () => $initializeFromParagraphs(initialContent)
          : undefined,
      }}
    >
      <RoutineVariablesProvider value={variablesContext}>
        <div className="rounded-md border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <EditorToolbar variables={variables} onSetVariableType={onSetVariableType} />
          <div className="relative">
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  aria-label="Routine"
                  className="min-h-40 w-full px-3 py-2 text-sm outline-none [&_p]:my-1 [&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:leading-tight [&_h1]:text-foreground first:[&_h1]:mt-0"
                />
              }
              placeholder={() => (
                <div className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">
                  Write the routine in plain language. Type @ to insert a variable.
                </div>
              )}
              ErrorBoundary={LexicalErrorBoundary}
            />
          </div>
          <HistoryPlugin />
          <OnDocChangePlugin onDocChange={onDocChange} />
          <ChipTypeaheadPlugin variables={variables} reservedRefKinds={reservedRefKinds} onCreateVariable={onCreateVariable} />
        </div>
      </RoutineVariablesProvider>
    </LexicalComposer>
  )
}
