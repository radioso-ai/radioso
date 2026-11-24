import type { ContextVariableValueType } from '@/lib/api'

type RevisionTestValueVariable = {
  id: string
  name: string
  valueType: ContextVariableValueType
}

type RevisionTestValue = {
  contextVariableId: string
  value: unknown
}

type RevisionTestValueValidation = {
  values: RevisionTestValue[]
  errors: Record<string, string>
}

/**
 * One entered sample as the API takes it: JSON parsed, a Yes/no as a boolean (the input offers
 * `true` and `false`), a number as a number, and anything else, a date included, as written.
 */
const parseSample = (variable: RevisionTestValueVariable, raw: string): { value: unknown } | { error: string } => {
  switch (variable.valueType) {
    case 'json':
      try {
        return { value: JSON.parse(raw) }
      } catch {
        return { error: `${variable.name} must contain valid JSON.` }
      }
    case 'boolean':
      return { value: raw === 'true' }
    case 'number': {
      const value = Number(raw)
      return Number.isFinite(value) ? { value } : { error: `${variable.name} must be a number.` }
    }
    default:
      return { value: raw }
  }
}

/** Parse every entered sample while retaining errors for all malformed fields. */
export const validateTestValueInputs = (
  variables: readonly RevisionTestValueVariable[],
  inputs: Readonly<Record<string, string>>,
): RevisionTestValueValidation => {
  const values: RevisionTestValue[] = []
  const errors: Record<string, string> = {}

  for (const variable of variables) {
    const raw = inputs[variable.id]?.trim()
    if (!raw) continue
    const parsed = parseSample(variable, raw)
    if ('error' in parsed) errors[variable.id] = parsed.error
    else values.push({ contextVariableId: variable.id, value: parsed.value })
  }

  return { values, errors }
}
