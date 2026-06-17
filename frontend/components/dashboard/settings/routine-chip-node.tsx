'use client'

import { useRef, useState, type ComponentType, type JSX } from 'react'
import { AlertTriangle, BadgeCheck, ChevronDown, CornerUpRight, Flag, Zap, type LucideIcon } from 'lucide-react'
import {
  $getNodeByKey,
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
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
import { useSkillDescriptor, RoutineSkillCatalogPopover } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import type { RoutineFieldGuardOp, RoutineFieldGuardUnit, RoutineSlotType } from '@/lib/api-types'
import { ROUTINE_SLOT_TYPES, type RoutineInputBinding, type RoutineSkillBindingState, type RoutineStepMode } from '@/lib/routine-prose'

import { useRoutineVariables } from '@/components/dashboard/settings/routine-variables-context'

// A chip is an atomic inline reference the author picks instead of typing raw syntax.
// Each kind renders with its own colour + glyph; the kind/type/comparison live as
// metadata on the node, never as visible syntax. A `skill` chip names a skill defined
// elsewhere (compiles to a tool step the runner dispatches through the skill port); a
// `condition` chip is a structured comparison ("decided in code"); the others are
// references/targets. An `end` chip is a branch target that completes the routine (the
// counterpart to a `handoff` chip, which escalates).
export type RoutineChipKind = 'variable' | 'skill' | 'handoff' | 'step' | 'condition' | 'end'

export type RoutineFieldGuardValue = string | number | boolean

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

  const removeSelf = () => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      node?.remove()
    })
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
        ) : kind === 'condition' ? (
          <>
            <DropdownMenuLabel>Decided in code</DropdownMenuLabel>
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

  // What a serialized line contributes. A variable becomes the {{slot.x}} wire form; all
  // other chips are structural and contribute no readable text — the line's prose carries
  // the instruction, while the chip's metadata (a skill's name, a branch target, a
  // condition's comparison) is captured separately by the compiler.
  getTextContent(): string {
    if (this.__chipKind === 'variable') return `{{slot.${this.__refId}}}`
    return ''
  }

  decorate(): JSX.Element {
    // A step (jump) chip surfaces its loop bound on the face so a backward jump reads as
    // "go to X · max N".
    const label = this.__chipKind === 'step' && this.__counterLimit != null
      ? `${this.__label} · max ${this.__counterLimit}`
      : this.__label
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

export function $isChipNode(node: LexicalNode | null | undefined): node is ChipNode {
  return node instanceof ChipNode
}
