import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  assertPublicHttpUrl,
  isPublicNetworkAddress,
  stripIpv6Brackets,
} from "../../shared/domain/publicNetwork.js";
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
  let url: URL;
  try {
    url = assertPublicHttpUrl(value);
  } catch (error) {
    throw new WebsiteCrawlerBadRequestError(
      error instanceof Error ? error.message : "Website URL must resolve to a publicly routable host",
    );
  }
  const hostname = stripIpv6Brackets(url.hostname.toLowerCase());

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    return;
  }

  const lookup = options?.lookup ?? ((host: string) => dnsLookup(host, { all: true }));
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new WebsiteCrawlerBadRequestError("Website URL host could not be resolved");
  }

  if (addresses.length === 0 || addresses.some((address) => !isPublicNetworkAddress(address.address))) {
    throw new WebsiteCrawlerBadRequestError("Website URL must resolve to a publicly routable host");
  }
};
