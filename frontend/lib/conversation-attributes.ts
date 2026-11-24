import type { ContextVariable } from '@/lib/api-types'
import type { AttributeFilter } from '@/lib/conversation-filters'

/** A Choice attribute the Inbox filters by, with every option a stored value can name. */
export interface AttributeFilterChoice {
  name: string
  options: Array<{ key: string; label: string; archived: boolean }>
}

/**
 * The attributes the Inbox offers as filters: Choice attributes that are not Private, by name. The
 * backend refuses any other, and an archived option still names the values stored under it.
 */
export const buildAttributeFilterChoices = (variables: readonly ContextVariable[]): AttributeFilterChoice[] =>
  variables
    .flatMap((variable) => variable.valueType === 'enum' && variable.sensitivity !== 'sensitive' && variable.options?.length
      ? [{
        name: variable.name,
        options: variable.options.map(({ key, label, archived }) => ({ key, label, archived })),
      }]
      : [])
    .sort((left, right) => left.name.localeCompare(right.name))

/**
 * The option that filters to conversations with no value of the attribute in their own
 * conversation scope. Option keys start with a letter, so no key can be this.
 */
export const ATTRIBUTE_FILTER_NOT_SET = '_not_set'

/** How much of a value the Inbox shows before "Show all": a JSON value can run to 32 KB. */
export const ATTRIBUTE_PREVIEW_CHARS = 160

export const previewAttributeValue = (text: string): { text: string; truncated: boolean } =>
  text.length > ATTRIBUTE_PREVIEW_CHARS
    ? { text: `${text.slice(0, ATTRIBUTE_PREVIEW_CHARS)}…`, truncated: true }
    : { text, truncated: false }

// One Radix Select item value carries both halves; JSON keeps any character in an option key intact.
export const encodeAttributeFilter = (filter: AttributeFilter): string => JSON.stringify([filter.name, filter.option])

export const decodeAttributeFilter = (value: string): AttributeFilter | null => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return { name: parsed[0], option: parsed[1] }
    }
  } catch {
    // Not an encoded filter: the "all" sentinel.
  }
  return null
}
