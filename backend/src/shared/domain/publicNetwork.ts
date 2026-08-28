import { isIP } from "node:net";

export class PublicNetworkPolicyError extends Error {
  constructor(message = "URL must resolve to a publicly routable host") {
    super(message);
    this.name = "PublicNetworkPolicyError";
  }
}

export const stripIpv6Brackets = (value: string): string =>
  value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;

export const assertPublicHttpUrl = (value: string | URL): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicNetworkPolicyError("URL must be valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublicNetworkPolicyError("URL must use http or https");
  }

  const hostname = stripIpv6Brackets(url.hostname.toLowerCase());
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new PublicNetworkPolicyError();
  }
  if (isIP(hostname) !== 0 && !isPublicNetworkAddress(hostname)) {
    throw new PublicNetworkPolicyError();
  }
  return url;
};

export const isPublicNetworkAddress = (address: string): boolean => {
  const normalizedAddress = stripIpv6Brackets(address.toLowerCase());
  return normalizedAddress.includes(":")
    ? isGloballyRoutableIpv6(normalizedAddress)
    : isGloballyRoutableIpv4(normalizedAddress);
};

const isGloballyRoutableIpv4 = (address: string): boolean => {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  const isNonPublic = (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
  return !isNonPublic;
};

const isGloballyRoutableIpv6 = (address: string): boolean => {
  const normalized = address.toLowerCase();
  const mappedIpv4 = parseIpv4MappedIpv6(normalized);
  if (mappedIpv4) return isGloballyRoutableIpv4(mappedIpv4);
  const nat64Ipv4 = parseNat64Ipv6(normalized);
  if (nat64Ipv4) return isGloballyRoutableIpv4(nat64Ipv4);
  const groups = expandIpv6Groups(normalized);
  if (!groups) return false;
  if (NON_PUBLIC_IPV6_EXCEPTIONS.some((prefix) => matchesIpv6Prefix(groups, prefix))) return false;
  return IANA_ALLOCATED_GLOBAL_UNICAST_PREFIXES.some((prefix) => matchesIpv6Prefix(groups, prefix));
};

const parseIpv4MappedIpv6 = (address: string): string | null => {
  const groups = expandIpv6Groups(address);
  if (!groups) return null;
  if (!(groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)) return null;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
};

const parseNat64Ipv6 = (address: string): string | null => {
  const groups = expandIpv6Groups(address);
  if (!groups) return null;
  const standardPrefix = groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;
  if (!standardPrefix) return null;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
};

const expandIpv6Groups = (address: string): number[] | null => {
  let normalized = address;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon === -1) return null;
    const ipv4Parts = parseIpv4Parts(normalized.slice(lastColon + 1));
    if (!ipv4Parts) return null;
    const high = ((ipv4Parts[0] << 8) | ipv4Parts[1]).toString(16);
    const low = ((ipv4Parts[2] << 8) | ipv4Parts[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`;
  }

  if ((normalized.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = normalized.split("::") as [string, string | undefined];
  const parseGroup = (group: string): number | null =>
    /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : null;
  const leftGroups = (leftRaw ? leftRaw.split(":") : []).map(parseGroup);
  const rightGroups = (rightRaw ? rightRaw.split(":") : []).map(parseGroup);
  if (leftGroups.some((group) => group === null) || rightGroups.some((group) => group === null)) return null;
  if (rightRaw === undefined) return leftGroups.length === 8 ? leftGroups as number[] : null;
  const missing = 8 - leftGroups.length - rightGroups.length;
  if (missing < 1) return null;
  return [
    ...leftGroups as number[],
    ...Array.from({ length: missing }, () => 0),
    ...rightGroups as number[],
  ];
};

const parseIpv4Parts = (address: string): number[] | null => {
  const parts = address.split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
};

interface Ipv6Prefix {
  groups: readonly number[];
  prefixLength: number;
}

const matchesIpv6Prefix = (address: readonly number[], prefix: Ipv6Prefix): boolean => {
  const completeGroups = Math.floor(prefix.prefixLength / 16);
  for (let index = 0; index < completeGroups; index += 1) {
    if (address[index] !== (prefix.groups[index] ?? 0)) return false;
  }

  const remainingBits = prefix.prefixLength % 16;
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (address[completeGroups] & mask) === ((prefix.groups[completeGroups] ?? 0) & mask);
};

const NON_PUBLIC_IPV6_EXCEPTIONS: readonly Ipv6Prefix[] = [
  // Documentation is carved out of the otherwise allocated 2001:c00::/23 block.
  { groups: [0x2001, 0x0db8], prefixLength: 32 },
];

// ALLOCATED, conventional global-unicast prefixes from the IANA registry as of
// 2025-10-10. Future/reserved space fails closed. IETF protocol assignments
// (2001::/23) and 6to4 (2002::/16) are intentionally not treated as public web
// destinations. Standard NAT64 and IPv4-mapped addresses are checked above by
// classifying their embedded IPv4 destination.
const IANA_ALLOCATED_GLOBAL_UNICAST_PREFIXES: readonly Ipv6Prefix[] = [
  { groups: [0x2001, 0x0200], prefixLength: 23 },
  { groups: [0x2001, 0x0400], prefixLength: 23 },
  { groups: [0x2001, 0x0600], prefixLength: 23 },
  { groups: [0x2001, 0x0800], prefixLength: 22 },
  { groups: [0x2001, 0x0c00], prefixLength: 23 },
  { groups: [0x2001, 0x0e00], prefixLength: 23 },
  { groups: [0x2001, 0x1200], prefixLength: 23 },
  { groups: [0x2001, 0x1400], prefixLength: 22 },
  { groups: [0x2001, 0x1800], prefixLength: 23 },
  { groups: [0x2001, 0x1a00], prefixLength: 23 },
  { groups: [0x2001, 0x1c00], prefixLength: 22 },
  { groups: [0x2001, 0x2000], prefixLength: 19 },
  { groups: [0x2001, 0x4000], prefixLength: 23 },
  { groups: [0x2001, 0x4200], prefixLength: 23 },
  { groups: [0x2001, 0x4400], prefixLength: 23 },
  { groups: [0x2001, 0x4600], prefixLength: 23 },
  { groups: [0x2001, 0x4800], prefixLength: 23 },
  { groups: [0x2001, 0x4a00], prefixLength: 23 },
  { groups: [0x2001, 0x4c00], prefixLength: 23 },
  { groups: [0x2001, 0x5000], prefixLength: 20 },
  { groups: [0x2001, 0x8000], prefixLength: 19 },
  { groups: [0x2001, 0xa000], prefixLength: 20 },
  { groups: [0x2001, 0xb000], prefixLength: 20 },
  { groups: [0x2003], prefixLength: 18 },
  { groups: [0x2400], prefixLength: 12 },
  { groups: [0x2410], prefixLength: 12 },
  { groups: [0x2600], prefixLength: 12 },
  { groups: [0x2610], prefixLength: 23 },
  { groups: [0x2620], prefixLength: 23 },
  { groups: [0x2630], prefixLength: 12 },
  { groups: [0x2800], prefixLength: 12 },
  { groups: [0x2a00], prefixLength: 12 },
  { groups: [0x2a10], prefixLength: 12 },
  { groups: [0x2c00], prefixLength: 12 },
];
