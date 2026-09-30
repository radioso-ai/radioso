/**
 * Who a thread is shown to. Operators see the teammate who wrote a human reply; a visitor sees
 * only the reply's signature. Chosen by the surface rendering the thread, never inferred from
 * which fields a message happens to carry.
 */
export type ReplyAttributionAudience = 'operator' | 'visitor'

const GENERIC_TEAMMATE = 'A teammate'

const present = (value: string | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** The name on a human-agent reply's badge for this audience. */
export const humanReplyAuthor = (
  message: { operatorLabel?: string; operatorDisplayName?: string },
  audience: ReplyAttributionAudience,
): string => {
  const signature = present(message.operatorDisplayName)
  if (audience === 'visitor') {
    return signature ?? GENERIC_TEAMMATE
  }
  return present(message.operatorLabel) ?? signature ?? GENERIC_TEAMMATE
}
