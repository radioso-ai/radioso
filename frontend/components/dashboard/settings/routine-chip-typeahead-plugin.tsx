'use client'

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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
  type TextNode,
} from 'lexical'

import {
  $createChipNode,
  $createConditionChipNode,
  $createDecisionChipNode,
  $isChipNode,
  type ChipNode,
  type RoutineChipKind,
} from '@/components/dashboard/settings/routine-chip-node'
import { findRoutineSkillDescriptor, normalizeSkillName, RoutineSkillCatalogContext } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import type { RoutineFieldGuardOp } from '@/lib/api-types'
import { slugifyVariableKey, type ApprovalDocOption } from '@/lib/routine-prose'

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
  // A read-only line the menu shows in place of choices (the surface already holds the one
  // skill it can bind). Selecting it only closes the menu.
  notice?: boolean

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
    notice?: boolean
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
    this.notice = data.notice
  }
}

// Stable empties for a surface with no slots, so the option memo is not invalidated by a
// fresh literal on every render.
const NO_VARIABLES: RoutineEditorVariable[] = []
const NO_RESERVED_REF_KINDS: Record<string, RoutineChipKind> = {}

export function ChipTypeaheadPlugin({
  variables = NO_VARIABLES,
  reservedRefKinds = NO_RESERVED_REF_KINDS,
  onCreateVariable,
  onCreateSkill,
  skillsOnly = false,
  skillMenuNotice = null,
}: {
  // A routine surface owns slots and flow targets; a skills-only surface has neither, so
  // these narrow to nothing rather than being threaded through as empty ceremony.
  variables?: RoutineEditorVariable[]
  reservedRefKinds?: Record<string, RoutineChipKind>
  onCreateVariable?: (variable: RoutineEditorVariable) => void
  // Bind one capability and nothing else: `#` behaves as usual, `@` never opens the menu.
  skillsOnly?: boolean
  // Shown instead of the skill choices when the host has already bound the one skill it can
  // hold, so the menu explains itself rather than looking broken.
  skillMenuNotice?: string | null
  // Authors a skill the catalog does not have yet. The host owns the form and the constraints —
  // this plugin only knows a name went out and a name may come back. Resolving to the created
  // name (not the typed one) is load-bearing: skill names are lowercase identifiers, so what the
  // author typed is often not what exists. `null` means the author backed out.
  onCreateSkill?: (typedName: string) => Promise<string | null>
}) {
  const [editor] = useLexicalComposerContext()
  const skillCatalog = useContext(RoutineSkillCatalogContext)
  const [query, setQuery] = useState<string | null>(null)
  // Which prefix opened the menu: `@` inserts a variable or a flow target, `#` inserts a skill.
  const [trigger, setTrigger] = useState<'@' | '#'>('@')
  // Custom trigger so names with underscores keep the menu open (the default matcher treats "_"
  // as a word boundary and cancels the popover), and so both `@` and `#` open it.
  const triggerFn = useCallback((text: string) => {
    const match = skillsOnly
      ? /(^|\s|\()(#)([A-Za-z0-9_-]*)$/.exec(text)
      : /(^|\s|\()([@#])([A-Za-z0-9_-]*)$/.exec(text)
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
  }, [skillsOnly])

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
    if (skillsOnly || trigger === '#') {
      if (skillMenuNotice) {
        return [new ChipMenuOption('skill-notice', {
          display: skillMenuNotice,
          kind: 'skill',
          isNew: false,
          refId: '',
          name: '',
          notice: true,
        })]
      }
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
      const isUncatalogued = Boolean(raw)
        && !findRoutineSkillDescriptor(skillCatalog.skills, raw, raw)
        && (!reservedRefKinds[slugifyVariableKey(raw)] || reservedRefKinds[slugifyVariableKey(raw)] === 'skill')
      // Inside a routine an unresolved chip is a placeholder the author fills in later, so the
      // bare name is offered. A binding surface would send it straight to a rejected save, so it
      // only offers the name once the host can actually author the skill behind it.
      if (isUncatalogued && !skillsOnly) {
        skills.push(new ChipMenuOption(`new-skill-${lowered}`, {
          display: `Skill (not in catalog): ${raw}`,
          kind: 'skill',
          isNew: true,
          refId: slugifyVariableKey(raw),
          name: raw,
        }))
      } else if (isUncatalogued && onCreateSkill) {
        skills.push(new ChipMenuOption(`create-skill-${lowered}`, {
          display: `Create skill “${raw}”`,
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
  }, [editor, skillCatalog.skills, variables, reservedRefKinds, query, trigger, skillsOnly, skillMenuNotice, onCreateSkill])

  // Inline creation hands control to a host dialog, so the chip is inserted long after the menu
  // closed. Skip the write if this editor has gone away in the meantime.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const insertSkillChip = useCallback((skillName: string) => {
    if (!mountedRef.current) return
    editor.update(() => {
      const chip = $createChipNode('skill', skillName, skillName)
      const trailing = $createTextNode(' ')
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        selection.insertNodes([chip, trailing])
        trailing.select()
        return
      }
      // The dialog took focus and the caret with it: the trigger text was removed from the end of
      // the value, so appending puts the chip back where it was being typed.
      const root = $getRoot()
      const last = root.getLastChild()
      if ($isElementNode(last)) {
        last.append(chip, trailing)
      } else {
        const paragraph = $createParagraphNode()
        paragraph.append(chip, trailing)
        root.append(paragraph)
      }
      trailing.select()
    })
  }, [editor])

  const onSelectOption = useCallback(
    (option: ChipMenuOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      if (option.notice) {
        closeMenu()
        return
      }
      if (option.kind === 'skill' && option.isNew && skillsOnly && onCreateSkill) {
        // Drop the trigger text first: the author is leaving for a form, and `#refund` left behind
        // would read as a chip that already exists.
        editor.update(() => {
          nodeToReplace?.remove()
        })
        closeMenu()
        void onCreateSkill(option.name).then((createdName) => {
          if (createdName) insertSkillChip(createdName)
        })
        return
      }
      editor.update(() => {
        if (option.kind === 'variable' && option.isNew) {
          onCreateVariable?.({ id: option.refId, name: option.name })
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
    [editor, insertSkillChip, onCreateSkill, onCreateVariable, skillsOnly],
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
                // The menu is portalled to the document body, so inside a modal dialog it has to
                // opt back into pointer events and out-stack the dialog's layer. `relative` is
                // load-bearing: z-index only applies to a positioned element.
                className="pointer-events-auto relative z-[60] max-h-60 min-w-52 overflow-auto rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
                role="listbox"
                aria-label={skillsOnly ? 'Insert a skill' : 'Insert a chip'}
              >
                {options.map((option, index) => (
                  <li
                    key={option.key}
                    role="option"
                    aria-selected={selectedIndex === index}
                    aria-disabled={option.notice ? true : undefined}
                    className={`rounded-sm px-2 py-1.5 ${option.notice ? 'text-muted-foreground' : 'cursor-pointer'} ${selectedIndex === index && !option.notice ? 'bg-accent text-accent-foreground' : ''}`}
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
