import type { RetrievalMetadataRule, RetrievalMetadataRuleOperator, RetrievalMetadataValueType } from '@/lib/api'

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

export const getRuleBehaviorLabel = (rule: RetrievalMetadataRule) => {
  const activation =
    rule.triggerMode === 'match_turn'
      ? 'Activates only when this turn matches the trigger instruction.'
      : 'Always active for every retrieval-backed turn.'
  const effect =
    rule.effect === 'filter'
      ? 'Hard filter: unmatched documents are removed unless the system backs off.'
      : 'Boost: matching documents are preferred but non-matching documents remain available.'

  return `${activation} ${effect}`
}

export const getRuleValuePlaceholder = (valueType: RetrievalMetadataValueType) => {
  if (valueType === 'date') return '2026-03-26'
  if (valueType === 'number') return '100'
  return 'e.g. et or example.com'
}
