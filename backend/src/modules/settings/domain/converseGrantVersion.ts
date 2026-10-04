import { createHash } from "node:crypto";

/**
 * Names the exact credential a grant-bound converse session was issued against. Rotating
 * the grant's token changes the version, which is what makes a live session stop working
 * without anything having to go looking for it.
 */
export const converseGrantVersion = (grant: { id: string; tokenHash: string }): string =>
  createHash("sha256").update(`${grant.id}:${grant.tokenHash}`).digest("base64url");
