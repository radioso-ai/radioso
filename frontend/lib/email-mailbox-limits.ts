import type { EmailMailbox } from './api-email-channel'

export type MailboxLimitKey = 'threadSendBudget' | 'hourlyGenerationBudget' | 'silenceThresholdHours'

type MailboxLimits = Pick<EmailMailbox, MailboxLimitKey>

/** Inclusive bounds the mailbox API accepts for each numeric limit (`UpdateEmailMailboxRequest`). */
export const MAILBOX_LIMIT_BOUNDS: Readonly<Record<MailboxLimitKey, readonly [number, number]>> = {
  threadSendBudget: [1, 20],
  hourlyGenerationBudget: [1, 1000],
  silenceThresholdHours: [1, 2160],
}

const LIMIT_KEYS = Object.keys(MAILBOX_LIMIT_BOUNDS) as MailboxLimitKey[]

/** The limits form as typed: numbers stay text until saved, so a half-typed value is never coerced. */
export type MailboxLimitsDraft = Record<MailboxLimitKey, string>

type MailboxLimitsChange = Partial<MailboxLimits>

type LimitParse = { ok: true; value: number } | { ok: false; error: string }

const WHOLE_NUMBER = /^\d+$/

export const parseMailboxLimit = (key: MailboxLimitKey, raw: string): LimitParse => {
  const [min, max] = MAILBOX_LIMIT_BOUNDS[key]
  const text = raw.trim()
  const value = WHOLE_NUMBER.test(text) ? Number(text) : Number.NaN
  return value >= min && value <= max ? { ok: true, value } : { ok: false, error: `Enter a whole number from ${min} to ${max}.` }
}

export const mailboxLimitsDraft = (mailbox: MailboxLimits): MailboxLimitsDraft => ({
  threadSendBudget: String(mailbox.threadSendBudget),
  hourlyGenerationBudget: String(mailbox.hourlyGenerationBudget),
  silenceThresholdHours: String(mailbox.silenceThresholdHours),
})

/** What a save would send (only fields that differ from the saved mailbox) and each invalid field's error. */
export const mailboxLimitsChange = (
  mailbox: MailboxLimits,
  draft: MailboxLimitsDraft,
): { change: MailboxLimitsChange; errors: Partial<Record<MailboxLimitKey, string>> } => {
  const change: MailboxLimitsChange = {}
  const errors: Partial<Record<MailboxLimitKey, string>> = {}
  for (const key of LIMIT_KEYS) {
    const parsed = parseMailboxLimit(key, draft[key])
    if (!parsed.ok) errors[key] = parsed.error
    else if (parsed.value !== mailbox[key]) change[key] = parsed.value
  }
  return { change, errors }
}
