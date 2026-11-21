import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

import {
  assertPublicHttpUrl,
  isPublicNetworkAddress,
  PublicHostUnresolvedError,
  PublicNetworkPolicyError,
  stripIpv6Brackets,
} from "../../domain/publicNetwork.js";

export { assertPublicHttpUrl } from "../../domain/publicNetwork.js";

type PublicLookupAddress = { address: string; family: number };
type PublicAddressResolver = (hostname: string) => Promise<PublicLookupAddress[]>;

const defaultResolver: PublicAddressResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export const resolvePublicAddresses = async (
  hostname: string,
  resolver: PublicAddressResolver = defaultResolver,
): Promise<PublicLookupAddress[]> => {
  let addresses: PublicLookupAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new PublicHostUnresolvedError();
  }
  if (addresses.length === 0 || addresses.some((entry) => !isPublicNetworkAddress(entry.address))) {
    throw new PublicNetworkPolicyError();
  }
  return addresses;
};

/**
 * An http(s) URL whose host resolves only to public addresses. Refuses with
 * `PublicNetworkPolicyError`, and a host that does not resolve with its `PublicHostUnresolvedError`
 * subclass, so a caller tells a private target from a resolver outage. Any other error is no refusal.
 */
export const assertPublicHttpTarget = async (url: string, resolver?: PublicAddressResolver): Promise<void> => {
  const target = assertPublicHttpUrl(url);
  await resolvePublicAddresses(stripIpv6Brackets(target.hostname.toLowerCase()), resolver);
};

export const createConnectionBoundPublicLookup = (
  resolver: PublicAddressResolver = defaultResolver,
): LookupFunction => (hostname, options, callback) => {
  void resolvePublicAddresses(hostname, resolver)
    .then((addresses) => {
      const requestedFamily = options.family === 4 || options.family === 6 ? options.family : null;
      const eligible = requestedFamily ? addresses.filter((entry) => entry.family === requestedFamily) : addresses;
      if (eligible.length === 0) {
        throw new PublicNetworkPolicyError("URL host has no publicly routable address for the requested family");
      }
      if (options.all) {
        callback(null, eligible);
        return;
      }
      const selected = eligible[0];
      callback(null, selected.address, selected.family);
    })
    .catch((error: unknown) => {
      callback(error instanceof Error ? error : new PublicNetworkPolicyError(), "", 0);
    });
};

type PublicUrlFetch = typeof fetch;

export const createPublicUrlFetch = (
  resolver: PublicAddressResolver = defaultResolver,
): PublicUrlFetch => {
  const agent = new Agent({
    connect: { lookup: createConnectionBoundPublicLookup(resolver) },
  });
  const dispatcher = agent.compose((dispatch) => (options, handler) => {
    if (!options.origin) throw new PublicNetworkPolicyError("Outbound request origin is required");
    assertPublicHttpUrl(options.origin);
    return dispatch(options, handler);
  });

  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === "string" || input instanceof URL ? input : input.url;
    assertPublicHttpUrl(rawUrl);
    const response = await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    });
    return response as unknown as Response;
  });
};

export const fetchPublicUrl = createPublicUrlFetch();
