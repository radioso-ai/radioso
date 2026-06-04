import type {
  MetadataFieldSuggestion,
  RetrievalMetadataCondition,
  RetrievalMetadataRule,
  RetrievalMetadataRuleOperator,
  RetrievalMetadataValueType,
} from '@/lib/api'

export const operatorOptionsForValueType = (
  valueType: RetrievalMetadataValueType
): RetrievalMetadataRuleOperator[] => {
  if (valueType === 'string') {
    return ['equals', 'not_equals', 'contains', 'not_contains']
  }
  if (valueType === 'boolean') {
    return ['equals', 'not_equals']
  }

  return ['equals', 'not_equals', 'lt', 'lte', 'gt', 'gte']
}

export const isDynamicTodayValue = (value: string) => value.trim().toLowerCase() === 'today()'

export const isIsoDateValue = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value.trim())

export const isValidDateRuleValue = (value: string) => {
  const normalized = value.trim()
  return normalized.length === 0 || isDynamicTodayValue(normalized) || isIsoDateValue(normalized)
}

export const createMetadataCondition = (
  overrides: Partial<RetrievalMetadataCondition> = {}
): RetrievalMetadataCondition => ({
  id: overrides.id ?? globalThis.crypto?.randomUUID?.() ?? `condition-${Date.now()}`,
  field: overrides.field ?? '',
  valueType: overrides.valueType ?? 'string',
  operator: overrides.operator ?? 'equals',
  value: overrides.value ?? '',
})

export const createDefaultMetadataRule = (
  metadataFieldSuggestions: MetadataFieldSuggestion[],
): RetrievalMetadataRule => {
  const suggestedField = metadataFieldSuggestions[0]
  const valueType = suggestedField?.inferredType ?? 'string'
  const value = valueType === 'boolean' ? 'true' : ''

  return syncRuleWithConditions({
    id: globalThis.crypto?.randomUUID?.() ?? `rule-${Date.now()}`,
    field: suggestedField?.field ?? '',
    valueType,
    operator: 'equals',
    value,
    combinator: 'and',
    effect: 'boost',
    enabled: true,
    triggerMode: 'always_on',
  }, [
    createMetadataCondition({
      field: suggestedField?.field ?? '',
      valueType,
      operator: 'equals',
      value,
    }),
  ])
}

export const getRuleConditions = (rule: RetrievalMetadataRule): RetrievalMetadataCondition[] => {
  if (Array.isArray(rule.conditions) && rule.conditions.length > 0) {
    return rule.conditions
  }

  return [
    createMetadataCondition({
      id: `${rule.id}-condition-1`,
      field: rule.field,
      valueType: rule.valueType,
      operator: rule.operator,
      value: rule.value,
    }),
  ]
}

export const syncRuleWithConditions = (
  rule: RetrievalMetadataRule,
  conditions: RetrievalMetadataCondition[]
): RetrievalMetadataRule => {
  const nextConditions = conditions.length > 0 ? conditions : [createMetadataCondition()]
  const primary = nextConditions[0]

  return {
    ...rule,
    field: primary?.field ?? '',
    valueType: primary?.valueType ?? 'string',
    operator: primary?.operator ?? 'equals',
    value: primary?.value ?? '',
    conditions: nextConditions,
    combinator: rule.combinator ?? 'and',
  }
}

export const getOperatorLabel = (
  operator: RetrievalMetadataRuleOperator,
  valueType: RetrievalMetadataValueType
) => {
  if (valueType === 'date') {
    switch (operator) {
      case 'equals':
        return 'Is on'
      case 'not_equals':
        return 'Is not on'
      case 'lt':
        return 'Is before'
      case 'lte':
        return 'Is on or before'
      case 'gt':
        return 'Is after'
      case 'gte':
        return 'Is on or after'
      default:
        return operator
    }
  }

  switch (operator) {
    case 'equals':
      return 'Equals'
    case 'not_equals':
      return 'Does not equal'
    case 'contains':
      return 'Contains'
    case 'not_contains':
      return 'Does not contain'
    case 'lt':
      return 'Less than'
    case 'lte':
      return 'Less than or equal'
    case 'gt':
      return 'Greater than'
    case 'gte':
      return 'Greater than or equal'
  }
}

export const getRulePreviewLabel = (rule: RetrievalMetadataRule) => {
  const conditions = getRuleConditions(rule)
  const renderedConditions = conditions.map((condition) => {
    const field = condition.field.trim() || 'this field'
    const operator = getOperatorLabel(condition.operator, condition.valueType).toLowerCase()
    const value = condition.value.trim() || 'a value'
    return `${field} ${operator} ${value}`
  })
  const effect = rule.effect === 'filter' ? 'Require match' : 'Prefer match'
  const joined =
    renderedConditions.length === 1
      ? renderedConditions[0]
      : renderedConditions.map((condition) => `(${condition})`).join(` ${(rule.combinator ?? 'and').toUpperCase()} `)
  return `${effect}: ${joined}`
}

export const getRuleBehaviorLabel = (rule: RetrievalMetadataRule) => {
  const activation =
    rule.triggerMode === 'match_turn'
      ? 'Activates only when the current question matches the intent.'
      : 'Always active for every retrieval-backed turn.'
  const effect =
    rule.effect === 'filter'
      ? 'Require match: unmatched documents are removed unless the system backs off.'
      : 'Prefer match: matching documents are preferred but non-matching documents remain available.'

  return `${activation} ${effect}`
}

export const getRuleValuePlaceholder = (valueType: RetrievalMetadataValueType) => {
  if (valueType === 'date') return '2026-03-26'
  if (valueType === 'number') return '100'
  return 'e.g. et or example.com'
}
