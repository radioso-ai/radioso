// Web Crypto's `randomUUID` is a global on Node 18+, Deno, Workers, and browsers,
// which is what keeps the core runnable on all of them.
export const createId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
