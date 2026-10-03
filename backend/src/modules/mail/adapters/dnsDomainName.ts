/**
 * Structural DNS name check shared by the domain provisioners: lower-cased, no trailing dot, at
 * least two labels, LDH labels of 1-63 characters, and an alphabetic or punycode top-level label.
 * Returns null for anything else, so no provider is ever asked to register a malformed name and
 * no such name reaches a file path.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOP_LEVEL_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const MAX_NAME_LENGTH = 253;

export const normalizeDomainName = (input: string): string | null => {
  const name = input.trim().toLowerCase().replace(/\.$/, "");
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return null;
  }
  const labels = name.split(".");
  const topLevel = labels.at(-1);
  if (labels.length < 2 || !topLevel || !TOP_LEVEL_LABEL.test(topLevel)) {
    return null;
  }
  return labels.every((label) => LABEL.test(label)) ? name : null;
};
