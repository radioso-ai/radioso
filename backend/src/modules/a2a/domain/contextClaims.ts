import { z } from "zod";

import type { AgentConverseOpening } from "../../settings/contracts/agentConverseSession.js";

/**
 * What a context token holds once opened: the settings opening, under a purpose tag and a version.
 * The tag keeps any other value sealed under the same keys from reading as a context; the version
 * lets a later shape be told apart from this one.
 */
const CONTEXT_PURPOSE = "a2a_context";
const CLAIMS_VERSION = 1;

const claimsSchema = z.object({
  p: z.literal(CONTEXT_PURPOSE),
  v: z.literal(CLAIMS_VERSION),
  w: z.string().min(1),
  a: z.string().min(1),
  s: z.string().min(1),
  o: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("walk_in"), publicId: z.string().min(1) }),
    z.object({ kind: z.literal("grant"), grantId: z.string().min(1), grantVersion: z.string().min(1) }),
  ]),
  e: z.string().nullable(),
});

export const encodeContextClaims = (opening: AgentConverseOpening): string => JSON.stringify({
  p: CONTEXT_PURPOSE,
  v: CLAIMS_VERSION,
  w: opening.workspaceId,
  a: opening.agentId,
  s: opening.publicSessionId,
  o: opening.origin,
  e: opening.expiresAt,
});

/** The opening a context token's plaintext names, or null for anything this codec did not write. */
export const decodeContextClaims = (plaintext: string): AgentConverseOpening | null => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(plaintext);
  } catch {
    return null;
  }
  const parsed = claimsSchema.safeParse(candidate);
  if (!parsed.success) {
    return null;
  }
  const { w, a, s, o, e } = parsed.data;
  return { workspaceId: w, agentId: a, publicSessionId: s, origin: o, expiresAt: e };
};
