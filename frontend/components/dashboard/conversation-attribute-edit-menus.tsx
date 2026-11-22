'use client'

import { ChevronDown, Plus, RotateCcw, X } from 'lucide-react'

import { attributeEditCopy } from '@/components/dashboard/settings/attribute-copy'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ConversationAttribute } from '@/lib/api-types'
import type { SettableAttribute, SettableOption } from '@/lib/conversation-attribute-edits'

/** One attribute's menu: pick an active option for this conversation, and undo the teammate's own value. */
export function AttributeRowMenu({
  attribute,
  options,
  resetAction,
  disabled,
  onSet,
  onReset,
}: {
  attribute: ConversationAttribute
  options: SettableOption[]
  resetAction: 'reset' | 'clear' | null
  disabled: boolean
  onSet: (key: string) => void
  onReset: () => void
}) {
  const current = attribute.scope === 'conversation' && typeof attribute.value === 'string' ? attribute.value : ''
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="size-6" disabled={disabled} aria-label={attributeEditCopy.editLabel(attribute.name)}>
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {attribute.scope === 'conversation' ? attributeEditCopy.setFor : attributeEditCopy.overridesVisitor}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current} onValueChange={(key) => { if (key !== current) onSet(key) }}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.key} value={option.key}>{option.label}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {resetAction ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onReset}>
              {resetAction === 'reset' ? <RotateCcw aria-hidden /> : <X aria-hidden />}
              {resetAction === 'reset' ? attributeEditCopy.reset : attributeEditCopy.clear}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** "Set attribute": the Choice attributes the conversation holds no value of, each with its active options. */
export function SetAttributeMenu({
  attributes,
  disabled,
  onSet,
}: {
  attributes: SettableAttribute[]
  disabled: boolean
  onSet: (name: string, key: string) => void
}) {
  if (attributes.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={disabled}>
          <Plus aria-hidden />
          {attributeEditCopy.setAttribute}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {attributes.map((attribute) => (
          <DropdownMenuSub key={attribute.name}>
            <DropdownMenuSubTrigger className="font-mono text-xs">{attribute.name}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {attribute.options.map((option) => (
                <DropdownMenuItem key={option.key} onSelect={() => onSet(attribute.name, option.key)}>{option.label}</DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
