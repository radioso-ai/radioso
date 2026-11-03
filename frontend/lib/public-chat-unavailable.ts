import type { WebsiteEmbedCopy } from './embed-widget'

/**
 * Why a public chat cannot go on. `link_inactive`: the link or the embed is gone or switched off.
 * `agent_unavailable`: the link is fine, but the agent behind it has never been published, so it
 * can answer nothing yet.
 */
export type PublicChatUnavailableReason = 'link_inactive' | 'agent_unavailable'

/** The API's error codes that end a public chat, by what they mean for the visitor. */
const REASON_OF_ERROR_CODE: Readonly<Record<string, PublicChatUnavailableReason>> = {
  not_found: 'link_inactive',
  agent_not_published: 'agent_unavailable',
}

/** Why the chat cannot go on, from the API's error code; null for an error that leaves it open. */
export const publicChatUnavailableReasonOf = (code: string | null | undefined): PublicChatUnavailableReason | null =>
  code && Object.hasOwn(REASON_OF_ERROR_CODE, code) ? REASON_OF_ERROR_CODE[code] : null

/** The line a visitor reads for each reason, from the copy the chat already resolved for their language. */
export const publicChatUnavailableMessage = (
  reason: PublicChatUnavailableReason,
  copy: Pick<WebsiteEmbedCopy, 'publicChatUnavailableMessage' | 'publicChatAgentUnavailableMessage'>,
): string => (reason === 'agent_unavailable' ? copy.publicChatAgentUnavailableMessage : copy.publicChatUnavailableMessage)
