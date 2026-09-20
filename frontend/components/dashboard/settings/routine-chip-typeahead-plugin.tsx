'use client'

import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AtSign, CircleCheck, CornerUpRight, GitBranch, ListChecks, Plus, Wrench } from 'lucide-react'

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
} from '@lexical/react/LexicalTypeaheadMenuPlugin'
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
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
import { useInsertSkillChip } from '@/components/dashboard/settings/use-insert-skill-chip'
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
// The palette groups its options the way an author thinks about them, not the way the block
// doc happens to model them. Only the groups a given menu instance can actually produce ever
// render — a `variablesOnly` menu never has a "Logic & flow controls" or "Skills" option to
// show, so those group headers simply never appear there.
const CHIP_GROUP_LABEL: Partial<Record<RoutineChipKind, string>> = {
  condition: 'Logic & flow controls',
  decision: 'Logic & flow controls',
  end: 'Logic & flow controls',
  handoff: 'Logic & flow controls',
  variable: 'Information',
  skill: 'Skills',
}
const CHIP_GROUP_ORDER = ['Logic & flow controls', 'Information', 'Skills', 'More']
const CHIP_GROUP_TILE_CLASS: Partial<Record<RoutineChipKind, string>> = {
  condition: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  decision: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  end: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  handoff: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  variable: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  skill: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
}

function chipOptionIcon(option: ChipMenuOption) {
  if (option.isNew) return <Plus className="h-3.5 w-3.5" />
  switch (option.kind) {
    case 'variable': return <AtSign className="h-3.5 w-3.5" />
    case 'skill': return <Wrench className="h-3.5 w-3.5" />
    case 'condition': return <GitBranch className="h-3.5 w-3.5" />
    case 'decision': return <ListChecks className="h-3.5 w-3.5" />
    case 'end': return <CircleCheck className="h-3.5 w-3.5" />
    case 'handoff': return <CornerUpRight className="h-3.5 w-3.5" />
    default: return <AtSign className="h-3.5 w-3.5" />
  }
}

// Shown under the highlighted row only, in place of a side tooltip: Lexical positions this
// menu in document coordinates next to the caret, where a fixed side panel would as often
// land off-screen as beside it, so a description line under the label is the position-safe
// version of the same idea.
function chipOptionDescription(option: ChipMenuOption): string | null {
  if (option.notice) return null
  switch (option.kind) {
    case 'variable':
      return option.isNew ? 'Create a new variable to reuse across this routine.' : 'Insert this collected value into the sentence.'
    case 'skill':
      return option.isNew ? 'Reference a skill this routine will call.' : 'Reference this skill by name.'
    case 'condition':
      return 'Branch on a decision already declared in this routine.'
    case 'decision':
      return 'Add a point where a person chooses between options.'
    case 'end':
      return 'End the routine here.'
    case 'handoff':
      return 'Hand off to a person here.'
    default:
      return null
  }
}

const NO_VARIABLES: RoutineEditorVariable[] = []
const NO_RESERVED_REF_KINDS: Record<string, RoutineChipKind> = {}

export function ChipTypeaheadPlugin({
  variables = NO_VARIABLES,
  reservedRefKinds = NO_RESERVED_REF_KINDS,
  onCreateVariable,
  onCreateSkill,
  skillsOnly = false,
  variablesOnly = false,
  skillMenuNotice = null,
  skillMenuEmptyMessage = null,
}: {
  // A routine surface owns slots and flow targets; a skills-only surface has neither, so
  // these narrow to nothing rather than being threaded through as empty ceremony.
  variables?: RoutineEditorVariable[]
  reservedRefKinds?: Record<string, RoutineChipKind>
  onCreateVariable?: (variable: RoutineEditorVariable) => void
  // Bind one capability and nothing else: `#` behaves as usual, `@` never opens the menu.
  skillsOnly?: boolean
  // The inverse bind: `@` offers existing variables plus "Create variable" and nothing else,
  // `#` never opens the menu. A step instruction stores text plus slot references only
  // (`RoutineBlockInstructionSegment`) — a skill runs through a tool step, not step prose, so
  // this surface must not offer to turn typed text into a skill, flow target, or gate.
  variablesOnly?: boolean
  // Shown instead of the skill choices when the host has already bound the one skill it can
  // hold, so the menu explains itself rather than looking broken.
  skillMenuNotice?: string | null
  // A binding surface can explain why its catalog is empty. Routine authoring intentionally
  // keeps its existing silent typeahead behavior.
  skillMenuEmptyMessage?: string | null
  // Authors a skill the catalog does not have yet. The host owns the form and the constraints —
  // this plugin only knows a name went out and a name may come back. Resolving to the created
  // name (not the typed one) is load-bearing: skill names are lowercase identifiers, so what the
  // author typed is often not what exists. `null` means the author backed out.
  onCreateSkill?: (typedName: string) => Promise<string | null>
}) {
  const [editor] = useLexicalComposerContext()
  const skillCatalog = useContext(RoutineSkillCatalogContext)
  const insertSkillChip = useInsertSkillChip()
  const [query, setQuery] = useState<string | null>(null)
  // Which prefix opened the menu: `@` inserts a variable or a flow target, `#` inserts a skill.
  const [trigger, setTrigger] = useState<'@' | '#'>('@')

  // The menu's DOM host, in the document only while the menu is open.
  //
  // That lifecycle is load-bearing rather than housekeeping. A modal surface freezes the
  // accessibility tree when it opens: it stamps `aria-hidden="true"` once on every `document.body`
  // child outside itself, and watches for nothing that arrives later. Lexical builds its menu
  // anchor during this plugin's first render and re-attaches it only while it is disconnected, so
  // an anchor already sitting in the body when a modal opens carries that stamp for the life of
  // the modal — the menu draws and clicks, yet no assistive technology (or role-based query) can
  // see it. Entering the document on open puts the anchor in after the sweep, so nothing stamps
  // it. Keeping the host a `body` child is equally deliberate: Lexical places the anchor with
  // `position: absolute` in document coordinates, which only lands correctly while its containing
  // block is the initial one, so the host must stay outside any positioned or transformed subtree.
  const [menuHost] = useState<HTMLDivElement | null>(() =>
    typeof document === 'undefined' ? null : document.createElement('div'),
  )
  const attachMenuHost = useCallback(() => {
    if (menuHost && !menuHost.isConnected) {
      document.body.append(menuHost)
    }
  }, [menuHost])
  const detachMenuHost = useCallback(() => {
    menuHost?.remove()
  }, [menuHost])
  // A menu still open at unmount would otherwise leave its host behind.
  useEffect(() => detachMenuHost, [detachMenuHost])
  // Custom trigger so names with underscores keep the menu open (the default matcher treats "_"
  // as a word boundary and cancels the popover), and so both `@` and `#` open it.
  const triggerFn = useCallback((text: string) => {
    const match = skillsOnly
      ? /(^|\s|\()(#)([A-Za-z0-9_-]*)$/.exec(text)
      : variablesOnly
        ? /(^|\s|\()(@)([A-Za-z0-9_-]*)$/.exec(text)
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
  }, [skillsOnly, variablesOnly])

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
    if (!variablesOnly && (skillsOnly || trigger === '#')) {
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
      // Only when nothing actionable is on offer. The notice selects to nothing, and the menu
      // highlights its first option, so leading with it would make Enter close the menu instead
      // of taking the create action sitting behind it. It also needs the catalog to be genuinely
      // empty: with skills present but none matching the query, "no skills qualify" is false.
      if (skillsOnly && skills.length === 0 && skillCatalog.skills.length === 0 && skillMenuEmptyMessage) {
        skills.push(new ChipMenuOption('skill-empty', {
          display: skillMenuEmptyMessage,
          kind: 'skill',
          isNew: false,
          refId: '',
          name: '',
          notice: true,
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
      if (!variablesOnly && canCreate('handoff')) {
        result.push(new ChipMenuOption(`new-handoff-${lowered}`, {
          display: `Handoff: ${raw}`,
          kind: 'handoff',
          isNew: true,
          refId,
          name: raw,
        }))
      }
    }

    // `variablesOnly` stops here: existing variables plus "Create variable" is the whole menu.
    // Everything below builds flow targets, gates, and skills — structure that belongs to the
    // Document row's own controls, not to typed step prose.
    if (variablesOnly) return result.slice(0, 8)

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
  }, [editor, skillCatalog.skills, variables, reservedRefKinds, query, trigger, skillsOnly, variablesOnly, skillMenuNotice, skillMenuEmptyMessage, onCreateSkill])

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
          if (createdName) insertSkillChip({ skillName: createdName })
        })
        return
      }
      if (option.kind === 'skill') {
        insertSkillChip({
          skillName: option.refId,
          displayName: option.name,
          nodeToReplace,
        })
        closeMenu()
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
        // Re-resolving a chip dropped back to raw text (double-click, then picking it again)
        // matches only the "@name" run itself, leaving whatever already followed it — often
        // the space this same insertion adds on every other path — as the chip's very next
        // sibling. Adding a second one there would double it up instead of round-tripping the
        // same text.
        const nextSibling = chip.getNextSibling()
        if ($isTextNode(nextSibling) && nextSibling.getTextContent().startsWith(' ')) {
          nextSibling.select(0, 0)
        } else {
          const trailing = $createTextNode(' ')
          chip.insertAfter(trailing)
          trailing.select()
        }
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
      // Naming a host is what keeps Lexical from appending the anchor to `document.body` on its
      // own during the first render, which is the moment the menu cannot afford to be there.
      parent={menuHost ?? undefined}
      onOpen={attachMenuHost}
      onClose={detachMenuHost}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => {
        if (!anchorElementRef.current || options.length === 0) return null
        // Keyboard navigation walks `options` in its original order, so every option keeps
        // its index from that array even after it's sorted into a group for display.
        const indexed = options.map((option, index) => ({ option, index }))
        const notices = indexed.filter((item) => item.option.notice)
        const grouped = new Map<string, typeof indexed>()
        for (const item of indexed) {
          if (item.option.notice) continue
          const label = CHIP_GROUP_LABEL[item.option.kind] ?? 'More'
          grouped.set(label, [...(grouped.get(label) ?? []), item])
        }
        const renderOption = ({ option, index }: { option: ChipMenuOption; index: number }) => {
          const highlighted = selectedIndex === index
          const description = highlighted ? chipOptionDescription(option) : null
          return (
            <li
              key={option.key}
              role="option"
              aria-selected={highlighted}
              aria-disabled={option.notice ? true : undefined}
              className={`flex items-start gap-2 rounded-sm px-2 py-1.5 ${option.notice ? 'text-muted-foreground' : 'cursor-pointer'} ${highlighted && !option.notice ? 'bg-accent text-secondary-foreground' : ''}`}
              onMouseEnter={() => setHighlightedIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault()
                selectOptionAndCleanUp(option)
              }}
            >
              {!option.notice ? (
                <span aria-hidden="true" className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${CHIP_GROUP_TILE_CLASS[option.kind] ?? 'bg-muted text-muted-foreground'}`}>
                  {chipOptionIcon(option)}
                </span>
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.display}</span>
                {description ? <span className="mt-0.5 block whitespace-normal text-xs font-normal text-secondary-foreground/70">{description}</span> : null}
              </span>
            </li>
          )
        }
        return createPortal(
          <ul
            // The menu is portalled into a host at the document body, so inside a modal dialog it has to
            // opt back into pointer events and out-stack the dialog's layer. `relative` is
            // load-bearing: z-index only applies to a positioned element.
            className="pointer-events-auto relative z-[60] max-h-72 min-w-72 overflow-auto rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
            role="listbox"
            aria-label={skillsOnly ? 'Insert a skill' : variablesOnly ? 'Insert a variable' : 'Insert a chip'}
          >
            {CHIP_GROUP_ORDER.filter((label) => grouped.has(label)).flatMap((label) => [
              <li key={`group-${label}`} role="presentation" aria-hidden="true" className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 first:pt-1">
                {label}
              </li>,
              ...grouped.get(label)!.map(renderOption),
            ])}
            {notices.map(renderOption)}
          </ul>,
          anchorElementRef.current,
        )
      }}
    />
  )
}
