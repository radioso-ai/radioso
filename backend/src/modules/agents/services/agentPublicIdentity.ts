import { randomBytes } from "node:crypto";

import type { AgentInput, AgentPublicIdentity } from "../domain.js";

/**
 * 16 random bytes rendered base64url are 22 characters and carry the 128 bits FR-024 asks for.
 * The `ag_` prefix makes a public id recognisable in a log line, a card, or a support ticket
 * without being mistaken for the embed launch token, which is a secret printed in page HTML.
 */
const PUBLIC_ID_PREFIX = "ag_";
const PUBLIC_ID_ENTROPY_BYTES = 16;

export const PUBLIC_ID_FORMAT = /^ag_[A-Za-z0-9_-]{22}$/;

export const mintPublicId = (): string =>
  `${PUBLIC_ID_PREFIX}${randomBytes(PUBLIC_ID_ENTROPY_BYTES).toString("base64url")}`;

/** A fresh identity for an agent whose current one is being revoked. */
export const rotatedPublicIdInput = (): AgentInput => ({ publicId: mintPublicId() });

type PublicIdentityState = Pick<
  AgentPublicIdentity,
  "publicId" | "agentCardEnabled" | "publicAgentAccessEnabled"
>;

interface PublicAccessChange {
  readonly agentCardEnabled: boolean;
  readonly publicAgentAccessEnabled: boolean;
  readonly walkInConversationsPerHour: number | null;
  readonly publicIdMinted: boolean;
}

/**
 * Describes a write that changed who can reach the agent, or nothing when the write left that
 * alone. The metadata names the settings and never the id itself: an audit trail is read by
 * support, and a public id in it is a live access key sitting in a searchable log.
 */
export const describePublicAccessChange = (
  before: Pick<AgentPublicIdentity, "publicId" | "agentCardEnabled" | "publicAgentAccessEnabled" | "walkInConversationsPerHour">,
  after: Pick<AgentPublicIdentity, "publicId" | "agentCardEnabled" | "publicAgentAccessEnabled" | "walkInConversationsPerHour">,
): PublicAccessChange | null => {
  const unchanged = before.agentCardEnabled === after.agentCardEnabled
    && before.publicAgentAccessEnabled === after.publicAgentAccessEnabled
    && before.walkInConversationsPerHour === after.walkInConversationsPerHour;
  if (unchanged) {
    return null;
  }
  return {
    agentCardEnabled: after.agentCardEnabled,
    publicAgentAccessEnabled: after.publicAgentAccessEnabled,
    walkInConversationsPerHour: after.walkInConversationsPerHour,
    publicIdMinted: before.publicId === null && after.publicId !== null,
  };
};

/**
 * Gives an agent a public id on the write that first makes it reachable, and leaves every later
 * write alone. Lazy because an id that exists is an id a caller can try, and idempotent because
 * rotation — not an ordinary settings save — is what replaces one.
 *
 * Deliberately a sibling of `AgentService.withRotatedTokens` rather than part of it: that function
 * mints channel secrets under the embed's rules, and a public id is neither a secret nor bound to
 * a surface. Folding the two together would mean enabling the embed mints a discovery id, and
 * publishing a card mints an embed token.
 */
export const ensurePublicIdMintedForInput = (current: PublicIdentityState, input: AgentInput): AgentInput => {
  if (current.publicId || input.publicId !== undefined) {
    return input;
  }
  const reachable = (input.agentCardEnabled ?? current.agentCardEnabled)
    || (input.publicAgentAccessEnabled ?? current.publicAgentAccessEnabled);
  return reachable ? { ...input, publicId: mintPublicId() } : input;
};
