import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { WebsiteCrawlerBadRequestError } from "./errors.js";

type LookupAddress = {
  address: string;
  family: number;
};

export const assertPublicWebsiteUrl = async (
  value: string,
  options?: {
    lookup?: (hostname: string) => Promise<LookupAddress[]>;
  },
): Promise<void> => {
  const url = parseHttpUrl(value);
  const hostname = stripIpv6Brackets(url.hostname.toLowerCase());
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new WebsiteCrawlerBadRequestError("Website URL must resolve to a publicly routable host");
  }

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new WebsiteCrawlerBadRequestError("Website URL must resolve to a publicly routable host");
    }
    return;
  }

  const lookup = options?.lookup ?? ((host: string) => dnsLookup(host, { all: true }));
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new WebsiteCrawlerBadRequestError("Website URL host could not be resolved");
  }

  if (addresses.length === 0 || addresses.some((address) => isPrivateAddress(address.address))) {
    throw new WebsiteCrawlerBadRequestError("Website URL must resolve to a publicly routable host");
  }
};

const parseHttpUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebsiteCrawlerBadRequestError("URL must be valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebsiteCrawlerBadRequestError("URL must use http or https");
  }
  return url;
};

const isPrivateAddress = (address: string): boolean => {
  const normalizedAddress = stripIpv6Brackets(address.toLowerCase());
  if (normalizedAddress.includes(":")) {
    return isPrivateIpv6(normalizedAddress);
  }
  return isPrivateIpv4(normalizedAddress);
};

const stripIpv6Brackets = (value: string): string =>
  value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;

const isPrivateIpv4 = (address: string): boolean => {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
};

const isPrivateIpv6 = (address: string): boolean => {
  const normalized = address.toLowerCase();
  const mappedIpv4 = parseIpv4MappedIpv6(normalized);
  if (mappedIpv4) {
    return isPrivateIpv4(mappedIpv4);
  }
  const nat64Ipv4 = parseNat64Ipv6(normalized);
  if (nat64Ipv4) {
    return isPrivateIpv4(nat64Ipv4);
  }
  const groups = expandIpv6Groups(normalized);
  if (!groups) {
    return true;
  }
  return (
    normalized === "::1" ||
    normalized === "::" ||
    (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) ||
    (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) ||
    (groups[0] === 0x2001 && groups[1] === 0x0002 && groups[2] === 0) ||
    (groups[0] === 0x2001 && groups[1] === 0x0db8) ||
    groups[0] >= 0xff00 ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
};

const parseIpv4MappedIpv6 = (address: string): string | null => {
  const groups = expandIpv6Groups(address);
  if (!groups) {
    return null;
  }
  const mappedPrefix = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (!mappedPrefix) {
    return null;
  }
  return [
    groups[6] >> 8,
    groups[6] & 0xff,
    groups[7] >> 8,
    groups[7] & 0xff,
  ].join(".");
};

const parseNat64Ipv6 = (address: string): string | null => {
  const groups = expandIpv6Groups(address);
  if (!groups) {
    return null;
  }
  const standardPrefix = groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;
  if (!standardPrefix) {
    return null;
  }
  return [
    groups[6] >> 8,
    groups[6] & 0xff,
    groups[7] >> 8,
    groups[7] & 0xff,
  ].join(".");
};

const expandIpv6Groups = (address: string): number[] | null => {
  let normalized = address;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon === -1) {
      return null;
    }
    const ipv4Parts = parseIpv4Parts(normalized.slice(lastColon + 1));
    if (!ipv4Parts) {
      return null;
    }
    const high = ((ipv4Parts[0] << 8) | ipv4Parts[1]).toString(16);
    const low = ((ipv4Parts[2] << 8) | ipv4Parts[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`;
  }

  if ((normalized.match(/::/g) ?? []).length > 1) {
    return null;
  }

  const [leftRaw, rightRaw] = normalized.split("::") as [string, string | undefined];
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const parseGroup = (group: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return null;
    }
    return Number.parseInt(group, 16);
  };
  const leftGroups = left.map(parseGroup);
  const rightGroups = right.map(parseGroup);
  if (leftGroups.some((group) => group === null) || rightGroups.some((group) => group === null)) {
    return null;
  }

  if (rightRaw === undefined) {
    return leftGroups.length === 8 ? leftGroups as number[] : null;
  }

  const missing = 8 - leftGroups.length - rightGroups.length;
  if (missing < 1) {
    return null;
  }
  return [
    ...leftGroups as number[],
    ...Array.from({ length: missing }, () => 0),
    ...rightGroups as number[],
  ];
};

const parseIpv4Parts = (address: string): number[] | null => {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
};
