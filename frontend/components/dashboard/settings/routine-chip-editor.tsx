'use client'

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { AtSign } from 'lucide-react'

import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
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
  type EditorState,
  type LexicalNode,
  type TextNode,
} from 'lexical'

import { $createHeadingNode, $isHeadingNode, HeadingNode } from '@lexical/rich-text'

import { $createAiConditionChipNode, $createApprovalChipNode, $createChipNode, $createConditionChipNode, $createDecisionChipNode, $createEndChipNode, $createOutcomeConditionChipNode, $createSlotFilledConditionChipNode, $createStepChipNode, $isChipNode, ChipNode, type RoutineChipKind } from '@/components/dashboard/settings/routine-chip-node'
import { findRoutineSkillDescriptor, normalizeSkillName, RoutineSkillCatalogContext } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { RoutineVariablesProvider } from '@/components/dashboard/settings/routine-variables-context'
import { Button } from '@/components/ui/button'
import type { RoutineFieldGuardOp, RoutineSlotType } from '@/lib/api-types'
import {
  OUTCOME_GUARD_REF,
  SLOT_FILLED_GUARD_REF,
  slugifyVariableKey,
  type ApprovalDocOption,
  type ChipDocVariable,
  type ProseParagraph,
  type ProseSegment,
} from '@radioso/routine-document'

export type RoutineEditorVariable = { id: string; name: string }

class ChipMenuOption extends MenuOption {
  display: string
  kind: RoutineChipKind
  isNew: boolean
  refId: string
  name: string
  // For a typed decision-branch condition (`@decision is approve`): the chosen option id and
  // the chip label. For creating a decision: the seeded choices.
  op?: RoutineFieldGuardOp
  value?: string
  chipLabel?: string
  decisionOptions?: ApprovalDocOption[]

  constructor(key: string, data: {
    display: string
    kind: RoutineChipKind
    isNew: boolean
    refId: string
    name: string
    op?: RoutineFieldGuardOp
    value?: string
    chipLabel?: string
    decisionOptions?: ApprovalDocOption[]
  }) {
    super(key)
    this.display = data.display
    this.kind = data.kind
    this.isNew = data.isNew
    this.refId = data.refId
    this.name = data.name
    this.op = data.op
    this.value = data.value
    this.chipLabel = data.chipLabel
    this.decisionOptions = data.decisionOptions
  }
}

// The Document tab owns every structural control (steps, branches, endings, skill
// bindings), so the inline editor's only affordance is inserting a variable — the one
// piece of structure that belongs inside a sentence.
function EditorToolbar() {
  const [editor] = useLexicalComposerContext()

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

  return (
    <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1 border-b border-input px-1.5 py-1">
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={insertVariableTrigger}>
        <AtSign className="h-4 w-4" />
        Variable
      </Button>
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
  // Which prefix opened the menu: `@` inserts a variable or a flow target, `#` inserts a skill.
  const [trigger, setTrigger] = useState<'@' | '#'>('@')
  // Custom trigger so names with underscores keep the menu open (the default matcher treats "_"
  // as a word boundary and cancels the popover), and so both `@` and `#` open it.
  const triggerFn = useCallback((text: string) => {
    const match = /(^|\s|\()([@#])([A-Za-z0-9_-]*)$/.exec(text)
    if (match === null) return null
    const leading = match[1] ?? ''
    const prefix = (match[2] ?? '@') as '@' | '#'
    const matchingString = match[3] ?? ''
    setTrigger((current) => (current === prefix ? current : prefix))
    return {
      leadOffset: match.index + leading.length,
      matchingString,
      replaceableString: `${prefix}${matchingString}`,
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
    // `#` opens a skills-only menu (a capability); `@` opens variables + flow targets (a value
    // or a branch). Splitting them keeps skills from crowding the variable menu.
    if (trigger === '#') {
      const skills = skillCatalog.skills
        .filter((skill) => {
          const catalogName = normalizeSkillName(skill.skillName)
          const displayName = normalizeSkillName(skill.displayName)
          return (!lowered || catalogName.includes(lowered) || displayName.includes(lowered)) && canCreateRef('skill', skill.skillName)
        })
        .map((skill) => new ChipMenuOption(`skill-${skill.skillName}`, {
          display: skill.displayName,
          kind: 'skill',
          isNew: false,
          refId: skill.skillName,
          name: skill.displayName,
        }))
      if (raw && !findRoutineSkillDescriptor(skillCatalog.skills, raw, raw) && (!reservedRefKinds[slugifyVariableKey(raw)] || reservedRefKinds[slugifyVariableKey(raw)] === 'skill')) {
        skills.push(new ChipMenuOption(`new-skill-${lowered}`, {
          display: `Skill (not in catalog): ${raw}`,
          kind: 'skill',
          isNew: true,
          refId: slugifyVariableKey(raw),
          name: raw,
        }))
      }
      return skills.slice(0, 8)
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
      // A named query resolves to a variable: document structure (handoffs, endings,
      // decisions) is authored in the surrounding Document rows, not typed into a sentence.
      return result.slice(0, 8)
    }

    // Decision authoring by typing: read the decisions already declared in the document so a
    // branch line can be typed as `@<decision> is <choice>`, plus `@end`/`@handoff` targets and
    // `@decision` to declare a new gate. (The decision chip carries the choices the branch
    // conditions reference; conditions compile to `<captureKey>.id == <option>` field guards.)
    const decisions: { captureKey: string; options: ApprovalDocOption[] }[] = []
    editor.getEditorState().read(() => {
      for (const block of $getRoot().getChildren()) {
        if (!$isElementNode(block)) continue
        for (const child of block.getChildren()) {
          if ($isChipNode(child) && child.getChipKind() === 'decision') {
            decisions.push({ captureKey: child.getCaptureKey() ?? child.getRefId(), options: child.getApprovalOptions() })
          }
        }
      }
    })
    const branchOptions: ChipMenuOption[] = []
    for (const decision of decisions) {
      for (const option of decision.options) {
        const choiceLabel = option.label || option.id
        const chipLabel = `${decision.captureKey} is ${choiceLabel}`
        if (lowered && !chipLabel.toLowerCase().includes(lowered) && !choiceLabel.toLowerCase().includes(lowered)) continue
        branchOptions.push(new ChipMenuOption(`cond-${decision.captureKey}-${option.id}`, {
          display: `If ${chipLabel}`,
          kind: 'condition',
          isNew: false,
          refId: decision.captureKey,
          name: chipLabel,
          op: 'equals',
          value: option.id,
          chipLabel,
        }))
      }
    }
    // Typed branch conditions come first — they're what you're writing on a branch line.
    result.unshift(...branchOptions)
    if (!lowered || 'end'.includes(lowered) || 'complete'.includes(lowered)) {
      result.push(new ChipMenuOption('target-end', { display: 'End (complete the routine)', kind: 'end', isNew: false, refId: 'done', name: 'end' }))
    }
    if (!lowered || 'handoff'.includes(lowered)) {
      result.push(new ChipMenuOption('target-handoff', { display: 'Handoff (escalate to a person)', kind: 'handoff', isNew: false, refId: 'handoff', name: 'handoff' }))
    }
    if (!lowered || 'decision'.includes(lowered) || (raw.length > 0 && decisions.length === 0)) {
      const captureKey = slugifyVariableKey(raw && lowered !== 'decision' ? raw : 'decision')
      result.push(new ChipMenuOption(`new-decision-${captureKey}`, {
        display: raw && lowered !== 'decision' ? `Decision: ${raw} (a person chooses)` : 'Decision (a person chooses)',
        kind: 'decision',
        isNew: true,
        refId: captureKey,
        name: captureKey,
        decisionOptions: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
      }))
    }
    return result.slice(0, 8)
  }, [editor, skillCatalog.skills, variables, reservedRefKinds, query, trigger])

  const onSelectOption = useCallback(
    (option: ChipMenuOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        if (option.kind === 'variable' && option.isNew) {
          onCreateVariable({ id: option.refId, name: option.name })
        }
        let chip: ChipNode
        if (option.kind === 'decision') {
          // Declare the gate inline; choices are seeded so branch lines have something to
          // reference, and the chip is click-editable for labels/targets afterwards.
          chip = $createDecisionChipNode(option.refId, option.decisionOptions ?? [])
        } else if (option.kind === 'condition') {
          // A typed decision branch: `<captureKey> is <choice>` → a decision field guard.
          chip = $createConditionChipNode(option.refId, option.op ?? 'equals', option.chipLabel ?? option.name, option.value ?? null, null, null)
        } else {
          const label = option.kind === 'variable' ? `@${option.name}` : option.name
          chip = $createChipNode(option.kind, option.refId, label)
        }
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
// One prose paragraph → a Lexical block (a variable becomes a chip, condition/handoff/step
// chips carry their metadata, everything else is literal text). Shared by the initial load
// and a clipboard paste.
function $proseParagraphToNode(paragraph: ProseParagraph): LexicalNode {
  const node = paragraph.headingLevel === 1 ? $createHeadingNode('h1') : $createParagraphNode()
  for (const segment of paragraph.segments) {
    if (segment.kind === 'text') {
      node.append($createTextNode(segment.text))
    } else if (segment.chipKind === 'condition' && segment.refId === OUTCOME_GUARD_REF) {
      // An outcome guard (branches on the preceding tool step's result): the status rides in
      // `value`. Recreated via its own node so the sentinel refId survives the round-trip.
      node.append($createOutcomeConditionChipNode(typeof segment.value === 'string' ? segment.value : segment.label))
    } else if (segment.chipKind === 'condition' && segment.refId === SLOT_FILLED_GUARD_REF) {
      // A slot-filled guard (continues once the named slots are present): the slot keys ride in
      // `values`. Recreated via its own node so the sentinel refId + slot set survive the round-trip.
      const keys = (segment.values ?? []).map((value) => String(value)).filter((key) => key.length > 0)
      node.append($createSlotFilledConditionChipNode(keys, segment.label))
    } else if (segment.chipKind === 'condition' && segment.op) {
      node.append($createConditionChipNode(segment.refId, segment.op, segment.label, segment.value ?? null, segment.values ?? null, segment.unit ?? null))
    } else if (segment.chipKind === 'condition') {
      // A decided-by-AI selector (no operator): a bare marker; the phrase rides in the adjacent
      // text segment, so the chip carries no payload.
      node.append($createAiConditionChipNode())
    } else if (segment.chipKind === 'step') {
      node.append($createStepChipNode(segment.refId, segment.label, segment.counterLimit ?? null))
    } else if (segment.chipKind === 'approval') {
      node.append($createApprovalChipNode(segment.captureKey ?? '', segment.options ?? []))
    } else if (segment.chipKind === 'decision') {
      node.append($createDecisionChipNode(segment.captureKey ?? '', segment.options ?? []))
    } else if (segment.chipKind === 'end') {
      // A named ending carries its own completion message in `value`; recreated via its own node
      // so the message survives the round-trip (the generic chip path drops it).
      node.append($createEndChipNode(segment.refId, typeof segment.value === 'string' ? segment.value : null, segment.label))
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

function OnParagraphChangePlugin({ onParagraphChange }: { onParagraphChange: (paragraphs: ProseParagraph[]) => void }) {
  const [editor] = useLexicalComposerContext()
  const callbackRef = useRef(onParagraphChange)
  const hasEmittedInitialDocRef = useRef(false)
  useEffect(() => {
    callbackRef.current = onParagraphChange
  })

  useEffect(() => {
    const emit = (editorState: EditorState) => {
      editorState.read(() => {
        callbackRef.current($readProseParagraphs())
      })
    }
    const unregister = editor.registerUpdateListener(({ editorState, prevEditorState, dirtyElements, dirtyLeaves }) => {
      // Replacing the callback is not a document edit. Each row receives a new parent
      // callback after a draft update and must not emit again on that alone.
      if (editorState === prevEditorState || (dirtyElements.size === 0 && dirtyLeaves.size === 0)) return
      emit(editorState)
    })

    if (!hasEmittedInitialDocRef.current) {
      hasEmittedInitialDocRef.current = true
      emit(editor.getEditorState())
    }

    return unregister
  }, [editor])

  return null
}

// The routine instruction editor for one document row: plain language plus `@` variable
// chips and `#` skill chips. Every structural control — steps, branches, endings, skill
// bindings — lives in the surrounding Document rows, so this surface stays a sentence.
export function RoutineInstructionEditor({
  initialContent,
  variables,
  onCreateVariable,
  onChange,
  ariaLabel,
}: {
  initialContent: ProseParagraph[]
  variables: ChipDocVariable[]
  onCreateVariable: (variable: RoutineEditorVariable) => void
  onChange: (segments: ProseSegment[]) => void
  ariaLabel?: string
}): JSX.Element {
  const reservedRefKinds = useMemo(
    () => Object.fromEntries(variables.map((variable) => [variable.id, 'variable' as RoutineChipKind])),
    [variables],
  )
  const handleParagraphChange = useCallback(
    (paragraphs: ProseParagraph[]) => onChange(paragraphs[0]?.segments ?? [{ kind: 'text', text: '' }]),
    [onChange],
  )
  // A variable's type, required, and mutable flags are owned by the Document row's own
  // controls; the chips here read them and never write back.
  const variablesContext = useMemo(
    () => ({
      variables,
      getType: (refId: string): RoutineSlotType => variables.find((variable) => variable.id === refId)?.type ?? 'text',
      setType: () => undefined,
      getRequired: (refId: string): boolean => variables.find((variable) => variable.id === refId)?.required ?? true,
      setRequired: () => undefined,
      getMutable: (refId: string): boolean => variables.find((variable) => variable.id === refId)?.mutable ?? false,
      setMutable: () => undefined,
    }),
    [variables],
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
        editorState: initialContent.length > 0
          ? () => $initializeFromParagraphs(initialContent)
          : undefined,
      }}
    >
      <RoutineVariablesProvider value={variablesContext}>
        <div className="routine-prose-surface rounded-md border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <EditorToolbar />
          <div className="relative">
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  aria-label={ariaLabel ?? 'Routine'}
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
          <OnParagraphChangePlugin onParagraphChange={handleParagraphChange} />
          <ChipTypeaheadPlugin variables={variables} reservedRefKinds={reservedRefKinds} onCreateVariable={onCreateVariable} />
        </div>
      </RoutineVariablesProvider>
    </LexicalComposer>
  )
}
