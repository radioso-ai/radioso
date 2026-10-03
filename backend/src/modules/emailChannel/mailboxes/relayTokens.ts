// Opaque mailbox tokens and the address shapes that carry them. A relay token is the whole local
// part of an address on the deployment's inbound domain; a thread token rides in the `+tag` of an
// address. Both are secrets: never log them or return them outside the owning mailbox's settings.

/** Source of cryptographically random bytes; the caller passes `node:crypto` `randomBytes`. */
type RandomByteSource = (size: number) => Uint8Array;

interface PlusAddressParts {
  /** Local part before the first `+`, case as given. */
  base: string;
  /** Text after the first `+`, case as given; null when there is none or it is empty. */
  tag: string | null;
  /** Lowercase domain. */
  domain: string;
}

interface RelayAddress {
  /** Canonical (uppercase) relay token. */
  relayToken: string;
  plusTag: string | null;
}

const TOKEN_BYTES = 16; // 128 bits
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 §6, unpadded
const RELAY_TOKEN_PATTERN = /^[A-Z2-7]{26}$/; // 26 = ceil(128 / 5)
// A bare `local@domain` with no whitespace and a single `@`; display names and quoted local parts
// are the MIME normalizer's job, not this one.
const BARE_ADDRESS_PATTERN = /^([^\s@]+)@([^\s@]+)$/;

const encodeBase32 = (bytes: Uint8Array): string => {
  let output = "";
  let buffer = 0;
  let bufferedBits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bufferedBits += 8;
    while (bufferedBits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bufferedBits - 5)) & 31];
      bufferedBits -= 5;
    }
    buffer &= (1 << bufferedBits) - 1;
  }
  if (bufferedBits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bufferedBits)) & 31];
  }
  return output;
};

/** A 26-character RFC 4648 base32 token from 128 random bits, used for relay and thread tokens. */
export const generateOpaqueToken = (randomBytes: RandomByteSource): string => {
  const bytes = randomBytes(TOKEN_BYTES);
  if (bytes.length < TOKEN_BYTES) {
    throw new Error(`Token source returned ${bytes.length} bytes; ${TOKEN_BYTES} are required.`);
  }
  return encodeBase32(bytes.subarray(0, TOKEN_BYTES));
};

/** Splits a bare address into its tag-free local part, its `+tag`, and its lowercase domain. */
export const splitPlusAddress = (address: string): PlusAddressParts | null => {
  const match = BARE_ADDRESS_PATTERN.exec(address.trim());
  if (!match) return null;
  const [, local = "", domain = ""] = match;
  const plusAt = local.indexOf("+");
  const base = plusAt === -1 ? local : local.slice(0, plusAt);
  const tag = plusAt === -1 ? "" : local.slice(plusAt + 1);
  if (base === "") return null;
  return { base, tag: tag === "" ? null : tag, domain: domain.toLowerCase() };
};

/**
 * Reads a relay address. Only an address on the inbound domain whose tag-free local part is a
 * well-formed token qualifies, so an address on any customer domain never parses as one.
 */
export const parseRelayAddress = (address: string, inboundDomain: string): RelayAddress | null => {
  const parts = splitPlusAddress(address);
  if (!parts || parts.domain !== inboundDomain.toLowerCase()) return null;
  const relayToken = parts.base.toUpperCase();
  if (!RELAY_TOKEN_PATTERN.test(relayToken)) return null;
  return { relayToken, plusTag: parts.tag };
};

/** The `+tag` of an address, verbatim, as a thread-token candidate. Matching is the lookup's job. */
export const parsePlusToken = (address: string): string | null => splitPlusAddress(address)?.tag ?? null;
