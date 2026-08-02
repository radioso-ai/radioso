// Web Crypto rather than `node:crypto`: the same global exists on Node 18+, Deno,
// Workers, and browsers, so the kit's core stays runtime-agnostic.
export const createId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
