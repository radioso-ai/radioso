import type {
  CreateCustomerEmailSkillInput,
  CustomerEmailSkillMode,
} from '@/lib/api-customer-email'

export type CustomerEmailInputKey = 'to' | 'subject' | 'bodyText' | 'bodyHtml' | 'cc' | 'replyTo'
export type CustomerEmailFieldMode = 'bind' | 'expose' | 'ignore'

export type CustomerEmailInputField = {
  key: CustomerEmailInputKey
  label: string
  required: boolean
}

export const customerEmailInputFields: CustomerEmailInputField[] = [
  { key: 'to', label: 'To', required: true },
  { key: 'subject', label: 'Subject', required: true },
  { key: 'bodyText', label: 'Body text', required: true },
  { key: 'bodyHtml', label: 'Body HTML', required: false },
  { key: 'cc', label: 'Cc', required: false },
  { key: 'replyTo', label: 'Reply-to', required: false },
]

export type CustomerEmailFieldDraft = {
  mode: CustomerEmailFieldMode
  value: string
  slotBinding: string
}

export type CustomerEmailSkillDraft = {
  skillName: string
  connectionId: string
  mode: CustomerEmailSkillMode
  enabled: boolean
  fields: Record<CustomerEmailInputKey, CustomerEmailFieldDraft>
}

export type CustomerEmailSkillDraftBuildResult =
  | CreateCustomerEmailSkillInput
  | { errors: string[] }

const defaultSlotBinding = (key: CustomerEmailInputKey) => key

export const defaultCustomerEmailSkillDraft = (connectionId = ''): CustomerEmailSkillDraft => ({
  skillName: 'support_email_customer',
  connectionId,
  mode: 'draft',
  enabled: true,
  fields: Object.fromEntries(customerEmailInputFields.map((field) => [
    field.key,
    {
      mode: field.required ? 'expose' : 'ignore',
      value: '',
      slotBinding: defaultSlotBinding(field.key),
    },
  ])) as Record<CustomerEmailInputKey, CustomerEmailFieldDraft>,
})

const hasField = (draft: CustomerEmailSkillDraft, key: CustomerEmailInputKey) => {
  const field = draft.fields[key]
  return field.mode === 'bind' ? field.value.trim().length > 0 : field.mode === 'expose'
}

export const buildCustomerEmailSkillDraft = (draft: CustomerEmailSkillDraft): CustomerEmailSkillDraftBuildResult => {
  const errors: string[] = []
  const skillName = draft.skillName.trim()
  const connectionId = draft.connectionId.trim()
  if (!skillName) errors.push('Skill name is required.')
  if (!connectionId) errors.push('Connection is required.')
  if (!hasField(draft, 'to')) errors.push('Recipient must be bound or exposed.')
  if (!hasField(draft, 'subject')) errors.push('Subject must be bound or exposed.')
  if (!hasField(draft, 'bodyText') && !hasField(draft, 'bodyHtml')) {
    errors.push('Body text or HTML must be bound or exposed.')
  }

  const boundInputs: Record<string, unknown> = {}
  const exposedInputs: Record<string, { slotBinding?: string }> = {}
  for (const field of customerEmailInputFields) {
    const draftField = draft.fields[field.key]
    if (draftField.mode === 'bind') {
      const value = draftField.value.trim()
      if (value) boundInputs[field.key] = value
    } else if (draftField.mode === 'expose') {
      const slotBinding = draftField.slotBinding.trim()
      exposedInputs[field.key] = slotBinding ? { slotBinding } : {}
    }
  }

  if (errors.length > 0) {
    return { errors }
  }

  return {
    skillName,
    connectionId,
    mode: draft.mode,
    boundInputs,
    exposedInputs,
    enabled: draft.enabled,
  }
}
