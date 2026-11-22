import type { ConversationAttribute } from '@/lib/api-types'
import type { AttributeFilterChoice } from '@/lib/conversation-attributes'

/** An option a teammate can set: an active one, by key, with the label they read. */
export interface SettableOption {
  key: string
  label: string
}

/** A Choice attribute the conversation holds no value of, with the options a teammate can set it to. */
export interface SettableAttribute {
  name: string
  options: SettableOption[]
}

/**
 * How a teammate undoes their own value of the conversation's attribute: `reset` hands an attribute
 * the conversation's agent fills back to the AI, `clear` removes it where nothing fills it. A value
 * the AI, the website or a routine set, or one kept for the visitor, has no undo here.
 */
export const attributeResetAction = (attribute: ConversationAttribute): 'reset' | 'clear' | null => {
  if (attribute.redacted || attribute.scope !== 'conversation' || attribute.writtenBy.kind !== 'operator') return null
  return attribute.classified ? 'reset' : 'clear'
}

const activeOptions = (choice: AttributeFilterChoice | undefined): SettableOption[] =>
  (choice?.options ?? []).filter((option) => !option.archived).map(({ key, label }) => ({ key, label }))

/** The options a teammate can set the attribute to; none for one the workspace's Choice attributes don't offer. */
export const settableOptions = (choices: readonly AttributeFilterChoice[], attribute: ConversationAttribute): SettableOption[] =>
  attribute.redacted || attribute.valueType !== 'enum' ? [] : activeOptions(choices.find((choice) => choice.name === attribute.name))

/** The Choice attributes "Set attribute" offers: the ones with no row yet that still have an active option. */
export const unsetAttributeChoices = (
  choices: readonly AttributeFilterChoice[],
  attributes: readonly ConversationAttribute[] | undefined,
): SettableAttribute[] => {
  const shown = new Set((attributes ?? []).map((attribute) => attribute.name))
  return choices
    .filter((choice) => !shown.has(choice.name))
    .map((choice) => ({ name: choice.name, options: activeOptions(choice) }))
    .filter((choice) => choice.options.length > 0)
}

/** The attributes with one edit applied: the attribute as the conversation now reads it, or gone when nothing holds it. */
export const applyAttributeChange = (
  attributes: readonly ConversationAttribute[] | undefined,
  name: string,
  changed: ConversationAttribute | null,
): ConversationAttribute[] =>
  [...(attributes ?? []).filter((attribute) => attribute.name !== name), ...(changed ? [changed] : [])]
    .sort((left, right) => left.name.localeCompare(right.name))
