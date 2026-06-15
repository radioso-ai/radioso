import { describe, expect, it } from 'vitest'

import {
  buildCustomerEmailSkillDraft,
  customerEmailInputFields,
  defaultCustomerEmailSkillDraft,
} from '@/lib/customer-email-skills'

describe('customer email skill draft builder', () => {
  it('builds API input from bound and exposed draft fields', () => {
    const draft = defaultCustomerEmailSkillDraft('connection-1')
    draft.skillName = 'support_email_customer'
    draft.mode = 'draft'
    draft.fields.to = {
      mode: 'expose',
      value: '',
      slotBinding: 'customerEmail',
    }
    draft.fields.subject = {
      mode: 'bind',
      value: 'Support follow-up',
      slotBinding: 'emailSubject',
    }
    draft.fields.bodyText = {
      mode: 'expose',
      value: '',
      slotBinding: 'emailBody',
    }
    draft.fields.replyTo = {
      mode: 'bind',
      value: 'support@example.com',
      slotBinding: 'replyTo',
    }

    expect(buildCustomerEmailSkillDraft(draft)).toEqual({
      skillName: 'support_email_customer',
      connectionId: 'connection-1',
      mode: 'draft',
      boundInputs: {
        subject: 'Support follow-up',
        replyTo: 'support@example.com',
      },
      exposedInputs: {
        to: { slotBinding: 'customerEmail' },
        bodyText: { slotBinding: 'emailBody' },
      },
      enabled: true,
    })
  })

  it('reports missing required logical fields without relying on layout state', () => {
    const draft = defaultCustomerEmailSkillDraft('connection-1')
    draft.skillName = 'support_email_customer'
    draft.fields.to.mode = 'expose'
    draft.fields.to.slotBinding = 'customerEmail'
    draft.fields.subject.mode = 'bind'
    draft.fields.subject.value = 'Support follow-up'
    draft.fields.bodyText.mode = 'ignore'
    draft.fields.bodyHtml.mode = 'ignore'

    const result = buildCustomerEmailSkillDraft(draft)

    expect(result).toEqual({
      errors: ['Body text or HTML must be bound or exposed.'],
    })
  })

  it('keeps the supported field list typed and ordered for UI rendering', () => {
    expect(customerEmailInputFields.map((field) => field.key)).toEqual([
      'to',
      'subject',
      'bodyText',
      'bodyHtml',
      'cc',
      'replyTo',
    ])
  })
})
