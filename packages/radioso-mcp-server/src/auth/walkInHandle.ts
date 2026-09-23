import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The store key every walk-in session is saved under. It is deliberately a prefix no
 * credential can produce, so the bearer door can refuse the whole keyspace in one test
 * rather than relying on a handle staying unguessable.
 */
const WALK_IN_STORE_PREFIX = "radioso-walk-in:";

/** `{id}.{signature}` — the id is server-minted, the signature is what makes it ours. */
const WALK_IN_HANDLE_PATTERN = /^([A-Za-z0-9_-]{22,64})\.([A-Za-z0-9_-]{22,64})$/u;

const sign = (secret: string, publicId: string, sourceDigest: string, id: string): string =>
  createHmac("sha256", secret)
    // Length-prefixed so no combination of ids and digests can collide by concatenation.
    .update(`v1:${publicId.length}:${publicId}:${sourceDigest.length}:${sourceDigest}:${id}`)
    .digest("base64url")
    .slice(0, 43);

const equals = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

/**
 * Mints a walk-in continuity handle. The id is random and server-chosen; the signature
 * binds it to this agent and this calling source, so an echoed handle proves it came
 * from a session this server opened for this caller rather than from a client that
 * picked a memorable string.
 */
export const mintWalkInHandle = (input: {
  secret: string;
  publicId: string;
  sourceDigest: string;
}): string => {
  const id = randomBytes(24).toString("base64url");
  return `${id}.${sign(input.secret, input.publicId, input.sourceDigest, id)}`;
};

/**
 * Returns the handle's id when the handle verifies for this agent and this source, and
 * `null` otherwise. A handle replayed from another source fails here, so it can never
 * reach the session another caller holds — the caller simply gets a new conversation.
 */
export const verifyWalkInHandle = (input: {
  secret: string;
  publicId: string;
  sourceDigest: string;
  handle: string | null | undefined;
}): string | null => {
  const match = WALK_IN_HANDLE_PATTERN.exec(input.handle ?? "");
  if (!match) {
    return null;
  }
  const [, id = "", signature = ""] = match;
  return equals(signature, sign(input.secret, input.publicId, input.sourceDigest, id)) ? id : null;
};

/**
 * The store key for one walk-in conversation. The calling source is part of the key as
 * well as part of the signature: even with a leaked secret, a handle names a session
 * only from the source it was minted for.
 */
export const walkInStoreKey = (input: {
  publicId: string;
  sourceDigest: string;
  id: string;
}): string => `${WALK_IN_STORE_PREFIX}${input.publicId}:${input.sourceDigest}:${input.id}`;

/** Whether an access token names the walk-in keyspace, which the bearer door refuses. */
export const isWalkInStoreKey = (accessToken: string): boolean =>
  accessToken.startsWith(WALK_IN_STORE_PREFIX);
