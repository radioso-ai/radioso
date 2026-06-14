'use client'

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { AtSign, BadgeCheck, Bold, Italic } from 'lucide-react'

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
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type EditorState,
  type TextNode,
} from 'lexical'

import { $createChipNode, $createConditionChipNode, $isChipNode, ChipNode, type RoutineChipKind } from '@/components/dashboard/settings/routine-chip-node'
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
import type { RoutineFieldGuardOp, RoutineFieldGuardUnit, RoutineSlotType } from '@/lib/api-types'
import {
  fieldGuardOpLabel,
  fieldGuardOpNeedsUnit,
  fieldGuardOpNeedsValue,
  fieldGuardOpsForType,
  formatConditionLabel,
  ROUTINE_FIELD_GUARD_UNITS,
  slugifyVariableKey,
  type ChipDocVariable,
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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  variables: ChipDocVariable[]
  onConfirm: (condition: ConditionDraft) => void
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

function EditorToolbar({ variables }: { variables: ChipDocVariable[] }) {
  const [editor] = useLexicalComposerContext()
  const [conditionOpen, setConditionOpen] = useState(false)
  const [formats, setFormats] = useState({ bold: false, italic: false })

  // Track the active inline formats at the caret so Bold/Italic show their pressed state.
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) {
          setFormats({ bold: selection.hasFormat('bold'), italic: selection.hasFormat('italic') })
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

  return (
    <div className="flex items-center gap-0.5 border-b border-input px-1.5 py-1">
      <Button type="button" variant={formats.bold ? 'secondary' : 'ghost'} size="sm" className="h-7 w-7 p-0" aria-label="Bold" aria-pressed={formats.bold} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}>
        <Bold className="h-4 w-4" />
      </Button>
      <Button type="button" variant={formats.italic ? 'secondary' : 'ghost'} size="sm" className="h-7 w-7 p-0" aria-label="Italic" aria-pressed={formats.italic} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}>
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
      <ConditionBuilderDialog open={conditionOpen} onOpenChange={setConditionOpen} variables={variables} onConfirm={insertCondition} />
    </div>
  )
}

function ChipTypeaheadPlugin({
  variables,
  onCreateVariable,
}: {
  variables: RoutineEditorVariable[]
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
      if (!variables.some((variable) => variable.name.toLowerCase() === lowered)) {
        result.push(new ChipMenuOption(`new-variable-${lowered}`, {
          display: `Create variable “${raw}”`,
          kind: 'variable',
          isNew: true,
          refId: slugifyVariableKey(raw),
          name: raw,
        }))
      }
      result.push(new ChipMenuOption(`new-action-${lowered}`, {
        display: `Action: ${raw}`,
        kind: 'action',
        isNew: true,
        refId: slugifyVariableKey(raw),
        name: raw,
      }))
      result.push(new ChipMenuOption(`new-handoff-${lowered}`, {
        display: `Handoff: ${raw}`,
        kind: 'handoff',
        isNew: true,
        refId: slugifyVariableKey(raw),
        name: raw,
      }))
    }
    return result.slice(0, 8)
  }, [variables, query])

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

function OnDocChangePlugin({ onDocChange }: { onDocChange: (blocks: RoutineDocBlock[]) => void }) {
  return (
    <OnChangePlugin
      onChange={(editorState: EditorState) => {
        editorState.read(() => {
          const blocks = $getRoot().getChildren().map((block) => ({
            text: block.getTextContent(),
            chips: $isElementNode(block)
              ? block.getChildren().filter($isChipNode).map((chip) => ({
                  kind: chip.getChipKind() as string,
                  refId: chip.getRefId(),
                  op: chip.getChipOp(),
                  value: chip.getChipValue(),
                  values: chip.getChipValues(),
                  unit: chip.getChipUnit(),
                }))
              : [],
          }))
          onDocChange(blocks)
        })
      }}
    />
  )
}

export function RoutineChipEditor({
  variables,
  onCreateVariable,
  onDocChange,
  onSetVariableType,
}: {
  variables: ChipDocVariable[]
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
        nodes: [ChipNode],
        onError: (error: Error) => {
          throw error
        },
        theme: {},
      }}
    >
      <RoutineVariablesProvider value={variablesContext}>
        <div className="rounded-md border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <EditorToolbar variables={variables} />
          <div className="relative">
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  aria-label="Routine"
                  className="min-h-40 w-full px-3 py-2 text-sm outline-none [&_p]:my-1"
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
          <ChipTypeaheadPlugin variables={variables} onCreateVariable={onCreateVariable} />
        </div>
      </RoutineVariablesProvider>
    </LexicalComposer>
  )
}
