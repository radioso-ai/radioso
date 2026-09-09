type RevisionTestValueVariable = {
  id: string
  name: string
  valueType: 'string' | 'json'
}

type RevisionTestValue = {
  contextVariableId: string
  value: unknown
}

type RevisionTestValueValidation = {
  values: RevisionTestValue[]
  errors: Record<string, string>
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
    if (variable.valueType !== 'json') {
      values.push({ contextVariableId: variable.id, value: raw })
      continue
    }
    try {
      values.push({ contextVariableId: variable.id, value: JSON.parse(raw) })
    } catch {
      errors[variable.id] = `${variable.name} must contain valid JSON.`
    }
  }

  return { values, errors }
}
