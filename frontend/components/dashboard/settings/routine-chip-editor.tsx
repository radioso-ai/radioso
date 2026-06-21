'use client'

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { AtSign, BadgeCheck, Bold, CornerUpRight, Database, Flag, Gavel, Heading1, Italic } from 'lucide-react'

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
  COMMAND_PRIORITY_NORMAL,
  COPY_COMMAND,
  FORMAT_TEXT_COMMAND,
  PASTE_COMMAND,
  type EditorState,
  type LexicalNode,
  type TextNode,
} from 'lexical'

import { $createHeadingNode, $isHeadingNode, HeadingNode } from '@lexical/rich-text'

import { $createApprovalChipNode, $createChipNode, $createConditionChipNode, $createStepChipNode, $isChipNode, ApprovalChipDialog, approvalChipTargets, ChipNode, type ApprovalChipState, type ApprovalChipTarget, type RoutineChipKind } from '@/components/dashboard/settings/routine-chip-node'
import { findRoutineSkillDescriptor, normalizeSkillName, RoutineSkillCatalogContext } from '@/components/dashboard/settings/routine-skill-catalog-popover'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import type { RoutineSkillCategory, SkillAuthoringDescriptor } from '@/lib/api-routine-skill-catalog'
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
  type ProseSegment,
  type RoutineDocBlock,
  type RoutineFieldGuardValue,
} from '@/lib/routine-prose'
import { looksLikeRoutineProse, parseProseDoc, serializeProseDoc } from '@/lib/routine-prose-tokens'

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

const SKILL_CATEGORY_ORDER: RoutineSkillCategory[] = ['retrieval', 'customer_email', 'external_mcp', 'built_in']
const SKILL_CATEGORY_LABELS: Record<RoutineSkillCategory, string> = {
  retrieval: 'Retrieval',
  customer_email: 'Customer email',
  external_mcp: 'External MCP',
  built_in: 'Built-in',
}

const groupSkillsByCategory = (skills: SkillAuthoringDescriptor[]) =>
  SKILL_CATEGORY_ORDER
    .map((category) => ({
      category,
      skills: skills
        .filter((skill) => skill.category === category)
        .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    }))
    .filter((group) => group.skills.length > 0)

function EditorToolbar({ variables, onSetVariableType }: { variables: ChipDocVariable[]; onSetVariableType: (refId: string, type: RoutineSlotType) => void }) {
  const [editor] = useLexicalComposerContext()
  const skillCatalog = useContext(RoutineSkillCatalogContext)
  const [conditionOpen, setConditionOpen] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [jumpTargets, setJumpTargets] = useState<{ id: string; title: string }[]>([])
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [approvalTargets, setApprovalTargets] = useState<ApprovalChipTarget[]>([])
  const [formats, setFormats] = useState({ bold: false, italic: false, step: false })
  const skillGroups = useMemo(() => groupSkillsByCategory(skillCatalog.skills), [skillCatalog.skills])

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

  const insertSkill = (skill: SkillAuthoringDescriptor) => {
    editor.focus(() => {
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return
        const chip = $createChipNode('skill', skill.skillName, skill.displayName)
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

  // Approval targets are the document's titled steps plus the two terminals the prose
  // editor always exposes (end + handoff).
  const openApproval = () => {
    const stepTargets: ApprovalChipTarget[] = []
    editor.getEditorState().read(() => {
      for (const block of $getRoot().getChildren()) {
        if ($isHeadingNode(block)) {
          const title = block.getTextContent().trim()
          if (title) stepTargets.push({ id: slugifyVariableKey(title), label: title })
        }
      }
    })
    setApprovalTargets(approvalChipTargets(stepTargets))
    setApprovalOpen(true)
  }

  const insertApproval = (state: ApprovalChipState) => {
    editor.focus(() => {
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return
        const chip = $createApprovalChipNode(state.captureKey, state.options)
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2">
            <Database className="h-4 w-4" />
            Skill
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {skillCatalog.isLoading ? (
            <DropdownMenuItem disabled>Loading skills...</DropdownMenuItem>
          ) : skillCatalog.error ? (
            <DropdownMenuItem disabled>{skillCatalog.error}</DropdownMenuItem>
          ) : skillGroups.length === 0 ? (
            <DropdownMenuItem disabled>No routine skills available.</DropdownMenuItem>
          ) : (
            skillGroups.map((group, index) => (
              <DropdownMenuGroup key={group.category}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel>{SKILL_CATEGORY_LABELS[group.category]}</DropdownMenuLabel>
                {group.skills.map((skill) => (
                  <DropdownMenuItem key={skill.skillName} onSelect={() => insertSkill(skill)} className="flex-col items-start gap-0.5">
                    <span className="text-sm font-medium">{skill.displayName}</span>
                    <span className="text-xs text-muted-foreground">{skill.skillName}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => setConditionOpen(true)} disabled={variables.length === 0}>
        <BadgeCheck className="h-4 w-4" />
        Condition
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={insertEnd}>
        <Flag className="h-4 w-4" />
        End
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={openApproval}>
        <Gavel className="h-4 w-4" />
        Approval
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
      <ApprovalChipDialog open={approvalOpen} onOpenChange={setApprovalOpen} targets={approvalTargets} initial={{ captureKey: '', options: [] }} onConfirm={insertApproval} />
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
  const skillCatalog = useContext(RoutineSkillCatalogContext)
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
    const reservedKindForRef = (refId: string) => reservedRefKinds[refId] ?? reservedRefKinds[slugifyVariableKey(refId)]
    const canCreateRef = (kind: RoutineChipKind, refId: string) => {
      const reservedKind = reservedKindForRef(refId)
      return !reservedKind || reservedKind === kind
    }
    const result: ChipMenuOption[] = variables
      .filter((variable) => !lowered || variable.name.toLowerCase().includes(lowered))
      .map((variable) => new ChipMenuOption(`var-${variable.id}`, {
        display: `@${variable.name}`,
        kind: 'variable',
        isNew: false,
        refId: variable.id,
        name: variable.name,
      }))
    const catalogMatches = skillCatalog.skills
      .filter((skill) => {
        const catalogName = normalizeSkillName(skill.skillName)
        const displayName = normalizeSkillName(skill.displayName)
        return (!lowered || catalogName.includes(lowered) || displayName.includes(lowered)) && canCreateRef('skill', skill.skillName)
      })
      .map((skill) => new ChipMenuOption(`skill-${skill.skillName}`, {
        display: `Skill: ${skill.displayName}`,
        kind: 'skill',
        isNew: false,
        refId: skill.skillName,
        name: skill.displayName,
      }))
    result.push(...catalogMatches)
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
      if (!findRoutineSkillDescriptor(skillCatalog.skills, raw, raw) && canCreate('skill')) {
        result.push(new ChipMenuOption(`new-skill-${lowered}`, {
          display: `Skill (not in catalog): ${raw}`,
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
  }, [skillCatalog.skills, variables, reservedRefKinds, query])

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
          inputBindings: chip.getInputBindings(),
          outputAssignments: chip.getOutputAssignments(),
          mode: chip.getMode() ?? undefined,
          captureKey: chip.getCaptureKey(),
          options: chip.getApprovalOptions(),
        }))
      : [],
  }))
}

// One prose paragraph → a Lexical block (a variable becomes a chip, condition/handoff/step
// chips carry their metadata, everything else is literal text). Shared by the initial load
// and a clipboard paste.
function $proseParagraphToNode(paragraph: ProseParagraph): LexicalNode {
  const node = paragraph.headingLevel === 1 ? $createHeadingNode('h1') : $createParagraphNode()
  for (const segment of paragraph.segments) {
    if (segment.kind === 'text') {
      node.append($createTextNode(segment.text))
    } else if (segment.chipKind === 'condition' && segment.op) {
      node.append($createConditionChipNode(segment.refId, segment.op, segment.label, segment.value ?? null, segment.values ?? null, segment.unit ?? null))
    } else if (segment.chipKind === 'step') {
      node.append($createStepChipNode(segment.refId, segment.label, segment.counterLimit ?? null))
    } else if (segment.chipKind === 'approval') {
      node.append($createApprovalChipNode(segment.captureKey ?? '', segment.options ?? []))
    } else {
      node.append($createChipNode(segment.chipKind, segment.refId, segment.label, {
        inputBindings: segment.inputBindings,
        outputAssignments: segment.outputAssignments,
        mode: segment.mode,
      }))
    }
  }
  return node
}

// Build the editor's initial document from loaded prose paragraphs.
function $initializeFromParagraphs(paragraphs: ProseParagraph[]): void {
  const root = $getRoot()
  if (root.getChildrenSize() > 0) return
  for (const paragraph of paragraphs) root.append($proseParagraphToNode(paragraph))
}

// Read the live tree into ordered prose paragraphs (text + inline chips), preserving where
// each chip sits — the shape the token serializer turns into portable clipboard text.
function $readProseParagraphs(): ProseParagraph[] {
  return $getRoot().getChildren().map((block) => {
    const segments: ProseSegment[] = []
    if ($isElementNode(block)) {
      for (const child of block.getChildren()) {
        if ($isChipNode(child)) {
          segments.push({
            kind: 'chip',
            chipKind: child.getChipKind(),
            refId: child.getRefId(),
            label: child.getRefId(),
            op: child.getChipOp() ?? undefined,
            value: child.getChipValue(),
            values: child.getChipValues(),
            unit: child.getChipUnit() ?? undefined,
            counterLimit: child.getChipCounterLimit(),
            inputBindings: child.getInputBindings(),
            outputAssignments: child.getOutputAssignments(),
            mode: child.getMode() ?? undefined,
            captureKey: child.getCaptureKey() ?? undefined,
            options: child.getApprovalOptions(),
          })
        } else {
          segments.push({ kind: 'text', text: child.getTextContent() })
        }
      }
    }
    return {
      ...($isHeadingNode(block) ? { headingLevel: 1 as const } : {}),
      segments,
    }
  })
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// True when the author has the entire routine selected. The routine is the unit we export,
// so copy only takes over the clipboard for a whole-document selection; a partial selection
// falls through to Lexical's native clipboard, which round-trips losslessly in-app and
// copies an ordinary text snippet to other apps. (Chips contribute the same text on both
// sides of the comparison, so an empty-bodied routine compares as a full selection too.)
function $selectionSpansDocument(): boolean {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || selection.isCollapsed()) return false
  const root = $getRoot()
  return root.getTextContentSize() === 0 || selection.getTextContent() === root.getTextContent()
}

// Make the routine copy/paste losslessly through an external file. Copying the whole
// routine serializes its frontmatter + chip tokens onto the clipboard's text flavours;
// paste detects that grammar and rebuilds the chips, lifting the frontmatter back into the
// name/trigger fields and recreating any variables the pasted text referenced. Cut is left
// to Lexical's native handler on purpose: cutting is an in-editor move (lossless via the
// native clipboard flavour), whereas exporting a routine as portable text is the copy path.
function ClipboardRoundTripPlugin({
  name,
  trigger,
  variables,
  onCreateVariable,
  onSetVariableType,
  onPasteFrontmatter,
}: {
  name: string
  trigger: string
  variables: ChipDocVariable[]
  onCreateVariable: (variable: RoutineEditorVariable) => void
  onSetVariableType: (refId: string, type: RoutineSlotType) => void
  onPasteFrontmatter?: (frontmatter: { name: string | null; trigger: string | null }) => void
}) {
  const [editor] = useLexicalComposerContext()
  const skillCatalog = useContext(RoutineSkillCatalogContext)

  // Commands register once (deps are just [editor]); the handlers read everything mutable —
  // header, variables, skill catalog, and the paste callbacks — through this ref so they
  // always see fresh values without re-registering on every render. The ref is synced after
  // each render (not during).
  const stateRef = useRef({ name, trigger, variables, skillNames: new Set<string>(), onCreateVariable, onSetVariableType, onPasteFrontmatter })
  useEffect(() => {
    stateRef.current = {
      name,
      trigger,
      variables,
      skillNames: new Set(skillCatalog.skills.map((skill) => skill.skillName)),
      onCreateVariable,
      onSetVariableType,
      onPasteFrontmatter,
    }
  })

  useEffect(() => {
    const unregisterCopy = editor.registerCommand(
      COPY_COMMAND,
      (event: ClipboardEvent | null) => {
        const clipboardData = event?.clipboardData
        if (!clipboardData) return false
        const state = editor.getEditorState()
        // Only the whole routine is exported as tokens; a partial selection is a snippet —
        // let Lexical's native copy handle it so in-editor fidelity is preserved.
        if (!state.read($selectionSpansDocument)) return false
        const { name: currentName, trigger: currentTrigger, variables: currentVariables } = stateRef.current
        const paragraphs = state.read($readProseParagraphs)
        // The plain-text token grammar has no approval form, so a routine with an approval
        // gate isn't exported as tokens — fall through to Lexical's native clipboard, which
        // round-trips losslessly in-app via the JSON flavour.
        if (paragraphs.some((paragraph) => paragraph.segments.some((segment) => segment.kind === 'chip' && segment.chipKind === 'approval'))) {
          return false
        }
        const text = serializeProseDoc({ name: currentName, trigger: currentTrigger, variables: currentVariables, paragraphs })
        event.preventDefault()
        clipboardData.setData('text/plain', text)
        clipboardData.setData('text/html', `<pre>${escapeHtml(text)}</pre>`)
        return true
      },
      COMMAND_PRIORITY_NORMAL,
    )

    const unregisterPaste = editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        const clipboardData = event.clipboardData
        if (!clipboardData) return false
        const text = clipboardData.getData('text/plain')
        if (!text || !looksLikeRoutineProse(text)) return false
        event.preventDefault()

        const { variables: currentVariables, skillNames, onCreateVariable, onSetVariableType, onPasteFrontmatter } = stateRef.current
        const parsed = parseProseDoc(text, (candidate) => skillNames.has(candidate))

        for (const variable of parsed.variables) {
          // A variable already in the doc keeps its current type and description — paste
          // adds what's missing rather than clobbering the author's local definitions.
          if (currentVariables.some((existing) => existing.id === variable.id)) continue
          onCreateVariable({ id: variable.id, name: variable.name })
          if (variable.type !== 'text') onSetVariableType(variable.id, variable.type)
        }
        if (onPasteFrontmatter && (parsed.name !== null || parsed.trigger !== null)) {
          onPasteFrontmatter({ name: parsed.name, trigger: parsed.trigger })
        }

        // A pasted whole routine (our frontmatter was actually parsed) replaces the
        // document; anything else — including a foreign doc that merely opens with `---` —
        // is inserted at the caret rather than wiping the current routine.
        const replaceWholeDoc = parsed.hadFrontmatter
        editor.update(() => {
          const nodes = parsed.paragraphs.map($proseParagraphToNode)
          if (replaceWholeDoc) {
            const root = $getRoot()
            root.clear()
            for (const node of nodes) root.append(node)
            root.selectEnd()
          } else {
            const selection = $getSelection()
            if ($isRangeSelection(selection)) selection.insertNodes(nodes)
          }
        })
        return true
      },
      COMMAND_PRIORITY_NORMAL,
    )

    return () => {
      unregisterCopy()
      unregisterPaste()
    }
  }, [editor])

  return null
}

// How a branch line is decided, derived structurally from its chips — never from the
// words (Radioso is multilingual). A line with no target chip isn't a branch. A branch
// with a condition chip, or a counter-bounded jump, is decided in code ('rule'); any other
// branch is decided by the AI from its prose ('ai').
function $branchDecisionKind(block: LexicalNode): 'rule' | 'ai' | null {
  if ($isHeadingNode(block) || !$isElementNode(block)) return null
  const chips = block.getChildren().filter($isChipNode)
  const hasTarget = chips.some((chip) => {
    const kind = chip.getChipKind()
    return kind === 'end' || kind === 'handoff' || kind === 'step'
  })
  if (!hasTarget) return null
  const deterministic = chips.some(
    (chip) => chip.getChipKind() === 'condition' || (chip.getChipKind() === 'step' && chip.getChipCounterLimit() != null),
  )
  return deterministic ? 'rule' : 'ai'
}

// Tag each branch line with its decision kind so the surface can badge "Rule" vs "AI
// decides" — so the author sees which forks are exact and which are the AI's judgment.
// The tag is a data attribute the stylesheet renders; it carries no editor state.
function BranchDecisionDecorationPlugin() {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    const apply = () =>
      editor.getEditorState().read(() => {
        for (const block of $getRoot().getChildren()) {
          const element = editor.getElementByKey(block.getKey())
          if (!element) continue
          const kind = $branchDecisionKind(block)
          if (kind) element.setAttribute('data-routine-branch', kind)
          else element.removeAttribute('data-routine-branch')
        }
      })
    apply()
    return editor.registerUpdateListener(apply)
  }, [editor])
  return null
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
  name = '',
  trigger = '',
  onCreateVariable,
  onDocChange,
  onSetVariableType,
  onPasteFrontmatter,
}: {
  variables: ChipDocVariable[]
  reservedRefKinds: Record<string, RoutineChipKind>
  initialContent?: ProseParagraph[]
  // The header fields live outside the editor; the editor takes them so a copy includes
  // the routine's frontmatter and a paste can lift it back out.
  name?: string
  trigger?: string
  onCreateVariable: (variable: RoutineEditorVariable) => void
  onDocChange: (blocks: RoutineDocBlock[]) => void
  onSetVariableType: (refId: string, type: RoutineSlotType) => void
  onPasteFrontmatter?: (frontmatter: { name: string | null; trigger: string | null }) => void
}): JSX.Element {
  const variablesContext = useMemo(
    () => ({
      variables,
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
        <div className="routine-prose-surface rounded-md border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
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
          <BranchDecisionDecorationPlugin />
          <ChipTypeaheadPlugin variables={variables} reservedRefKinds={reservedRefKinds} onCreateVariable={onCreateVariable} />
          <ClipboardRoundTripPlugin
            name={name}
            trigger={trigger}
            variables={variables}
            onCreateVariable={onCreateVariable}
            onSetVariableType={onSetVariableType}
            onPasteFrontmatter={onPasteFrontmatter}
          />
        </div>
      </RoutineVariablesProvider>
    </LexicalComposer>
  )
}
