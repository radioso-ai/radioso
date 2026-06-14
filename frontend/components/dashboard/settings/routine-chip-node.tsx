'use client'

import type { ComponentType, JSX, ReactNode } from 'react'
import { BadgeCheck, CornerUpRight, Zap, type LucideIcon } from 'lucide-react'
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
import type { RoutineFieldGuardOp, RoutineFieldGuardUnit, RoutineSlotType } from '@/lib/api-types'
import { ROUTINE_SLOT_TYPES } from '@/lib/routine-prose'

import { useRoutineVariables } from '@/components/dashboard/settings/routine-variables-context'

// A chip is an atomic inline reference the author picks instead of typing raw syntax.
// Each kind renders with its own colour + glyph; the kind/type/comparison live as
// metadata on the node, never as visible syntax. A `condition` chip is a structured
// comparison ("decided in code"); the others are references/targets.
export type RoutineChipKind = 'variable' | 'action' | 'handoff' | 'step' | 'condition'

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
  },
  SerializedLexicalNode
>

const KIND_META: Record<RoutineChipKind, { className: string; icon: LucideIcon | null }> = {
  variable: { className: 'border-amber-300 bg-amber-100 text-amber-900', icon: null },
  action: { className: 'border-emerald-300 bg-emerald-100 text-emerald-900', icon: Zap },
  handoff: { className: 'border-rose-300 bg-rose-100 text-rose-900', icon: CornerUpRight },
  step: { className: 'border-sky-300 bg-sky-100 text-sky-900', icon: CornerUpRight },
  condition: { className: 'border-indigo-300 bg-indigo-100 text-indigo-900', icon: BadgeCheck },
}

function ChipBadge({ kind, label }: { kind: RoutineChipKind; label: string }): JSX.Element {
  const meta = KIND_META[kind]
  const Icon: ComponentType<{ className?: string }> | null = meta.icon
  return (
    <span
      className={`inline-flex select-none items-center gap-1 rounded-md border px-1.5 py-0 text-xs font-medium ${meta.className}`}
    >
      {Icon ? <Icon className="h-3 w-3" /> : null}
      {label}
    </span>
  )
}

function ChipMenu({ nodeKey, kind, refId, children }: { nodeKey: NodeKey; kind: RoutineChipKind; refId: string; children: ReactNode }): JSX.Element {
  const [editor] = useLexicalComposerContext()
  const { getType, setType } = useRoutineVariables()

  const removeSelf = () => {
    editor.update(() => {
      $getNodeByKey(nodeKey)?.remove()
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" contentEditable={false} data-routine-chip={kind} className="mx-0.5 cursor-pointer align-baseline outline-none">
          {children}
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

  static getType(): string {
    return 'routine-chip'
  }

  static clone(node: ChipNode): ChipNode {
    return new ChipNode(node.__chipKind, node.__refId, node.__label, node.__key, node.__op, node.__value, node.__values, node.__unit)
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
  ) {
    super(key)
    this.__chipKind = chipKind
    this.__refId = refId
    this.__label = label
    this.__op = op
    this.__value = value
    this.__values = values
    this.__unit = unit
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

  // What a serialized line contributes. A variable becomes the {{slot.x}} wire form;
  // an action contributes its readable label (it's part of the instruction); handoff,
  // step and condition chips are structural, so they contribute no readable text — the
  // line's prose / the condition chip's metadata carry the branch's meaning.
  getTextContent(): string {
    if (this.__chipKind === 'variable') return `{{slot.${this.__refId}}}`
    if (this.__chipKind === 'action') return this.__label
    return ''
  }

  decorate(): JSX.Element {
    return (
      <ChipMenu nodeKey={this.getKey()} kind={this.__chipKind} refId={this.__refId}>
        <ChipBadge kind={this.__chipKind} label={this.__label} />
      </ChipMenu>
    )
  }
}

export function $createChipNode(chipKind: RoutineChipKind, refId: string, label: string): ChipNode {
  return new ChipNode(chipKind, refId, label)
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
