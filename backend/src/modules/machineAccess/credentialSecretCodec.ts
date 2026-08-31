import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { unauthorized } from "../../shared/domain/errors.js";

const TOKEN_PREFIXES = { personal: "radioso_pat_v1_", service: "radioso_svc_v1_" } as const;
const TOKEN_PATTERN = /^radioso_(?:pat|svc)_v1_[A-Za-z0-9_-]{43}$/;

export interface IssuedMachineSecret {
  secret: string;
  tokenHash: string;
  tokenPrefix: string;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export const issueMachineSecret = (kind: keyof typeof TOKEN_PREFIXES = "personal"): IssuedMachineSecret => {
  const prefix = TOKEN_PREFIXES[kind];
  const secret = `${prefix}${randomBytes(32).toString("base64url")}`;
  return { secret, tokenHash: hash(secret), tokenPrefix: secret.slice(0, prefix.length + 8) };
};

export const hashMachineSecret = (secret: string): string => {
  if (!TOKEN_PATTERN.test(secret)) throw unauthorized();
  return hash(secret);
};

export const verifierMatches = (secret: string, verifier: string): boolean => {
  try {
    const expected = Buffer.from(hashMachineSecret(secret), "hex");
    const received = Buffer.from(verifier, "hex");
    return expected.length === received.length && timingSafeEqual(expected, received);
  } catch {
    return false;
  }
};
