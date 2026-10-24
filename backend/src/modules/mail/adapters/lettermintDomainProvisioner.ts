import { createHash } from "node:crypto";

import type {
  DnsRecordView,
  DomainReadiness,
  DomainRegistration,
  EmailDomainProvisioner,
  ProviderDomain,
  ReadinessStatus,
} from "../emailDomainProvisioner.js";
import { normalizeDomainName } from "./dnsDomainName.js";
import { LettermintApiError, isRecord, type LettermintApiClient } from "./lettermintApi.js";

/**
 * Registers a workspace's own domain with Lettermint through the Team API. Sending readiness comes
 * from the domain's DNS records. Receiving is not a domain property at Lettermint: direct
 * receiving on a domain is an inbound route in the deployment's project whose custom domain is
 * that domain, so the project-scoped webhook covers it. The provisioner manages only routes it
 * created, found by a slug derived from the domain name.
 *
 * Domains belong to the Lettermint team, which serves several deployments, each its own project,
 * and also holds Radioso's own unrestricted sender domain. A registration is this deployment's
 * only when it is restricted to the deployment's project, which also means only that project can
 * send from it; the provisioner adopts or deletes no other.
 */

interface LettermintDomainProvisionerOptions {
  api: LettermintApiClient;
  /** The deployment's Lettermint project: it holds the receiving routes, and only it sends from the domains registered here. */
  projectId: string;
}

interface LettermintDnsRecord {
  type: string;
  name: string;
  value: string;
  status: string;
  purpose: string;
  required: boolean;
}

interface LettermintDomain {
  id: string;
  name: string;
  records: readonly LettermintDnsRecord[];
  /** The projects allowed to send from the domain; empty when every project on the team may. */
  projectIds: readonly string[];
}

interface LettermintReceivingRoute {
  id: string;
  inboundDomain: string | null;
  mxHostname: string | null;
  verified: boolean;
}

/** Lettermint's documented MX host and priority; the API returns the host but never the priority. */
const DEFAULT_MX_HOSTNAME = "lettermint.mx";
const RECEIVING_MX_PRIORITY = 10;
/** Lettermint's documented default inbound spam threshold: mail scoring at or above it is quarantined. */
const INBOUND_SPAM_THRESHOLD = 5;
const ROUTE_SLUG_PREFIX = "radioso-inbound-";
const ROUTE_SLUG_HASH_LENGTH = 16;

export class LettermintEmailDomainProvisioner implements EmailDomainProvisioner {
  readonly provider = "lettermint";

  constructor(private readonly options: LettermintDomainProvisionerOptions) {}

  async registerSendingDomain(domain: string): Promise<DomainRegistration> {
    const name = normalizeDomainName(domain);
    if (!name) {
      return { ok: false, refused: "invalid_domain" };
    }
    let created: LettermintDomain;
    try {
      created = parseDomain(await this.options.api.request("team", "POST", "/domains", { body: { domain: name } }));
    } catch (error) {
      if (error instanceof LettermintApiError && error.statusCode === 422) {
        return { ok: false, refused: await this.refusalFor(name, error) };
      }
      throw error;
    }
    await this.restrictToProject(created.id);
    return { ok: true, ...(await this.providerDomainOf(await this.readDomain(created.id))) };
  }

  /**
   * The registration of the name restricted to this deployment's project. The team also holds
   * other deployments' domains and unrestricted ones, such as Radioso's own sender domain; those
   * are not this deployment's to report.
   */
  async findByName(domain: string): Promise<ProviderDomain | null> {
    const name = normalizeDomainName(domain);
    if (!name) {
      return null;
    }
    const listing = await this.findListedByName(name);
    if (!listing) {
      return null;
    }
    const found = await this.readDomain(listing.id);
    return this.isOwn(found) ? this.providerDomainOf(found) : null;
  }

  /** The team's registration of exactly `name`; `filter[domain]` matches part of a name. */
  private findListedByName(name: string): Promise<{ id: string } | null> {
    return this.findListed("/domains", { "filter[domain]": name }, (entry) =>
      typeof entry.domain === "string" && entry.domain.toLowerCase() === name);
  }

  /**
   * A receiving route sends every address on its domain to this deployment, so one is made only
   * for this deployment's own domain; any other is not found here.
   */
  async enableReceiving(providerDomainId: string): Promise<DomainReadiness> {
    const domain = await this.readDomain(providerDomainId);
    if (!this.isOwn(domain)) {
      throw new LettermintApiError("not_found", null, null);
    }
    const route = (await this.findReceivingRoute(domain.name)) ?? (await this.createReceivingRoute(domain.name));
    return readinessOf(domain, route);
  }

  async requestVerification(providerDomainId: string): Promise<void> {
    const domain = await this.readDomain(providerDomainId);
    await requestedCheck(this.options.api.request("team", "POST", `${domainPath(providerDomainId)}/dns-records/verify`));
    const route = await this.findReceivingRoute(domain.name);
    if (route) {
      await requestedCheck(this.options.api.request("team", "POST", `${routePath(route.id)}/verify-inbound-domain`));
    }
  }

  async readiness(input: { providerDomainId: string; domain: string }): Promise<DomainReadiness> {
    const domain = await this.readDomain(input.providerDomainId);
    return readinessOf(domain, await this.findReceivingRoute(domain.name));
  }

  /** Removes only a registration this deployment holds; another deployment's or an unrestricted one stays. */
  async remove(providerDomainId: string): Promise<void> {
    let domain: LettermintDomain;
    try {
      domain = await this.readDomain(providerDomainId);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    if (!this.isOwn(domain)) {
      return;
    }
    const route = await this.findReceivingRoute(domain.name);
    if (route) {
      await ignoringNotFound(this.options.api.request("team", "DELETE", routePath(route.id)));
    }
    await ignoringNotFound(this.options.api.request("team", "DELETE", domainPath(providerDomainId)));
  }

  /**
   * A 422 on the `domain` field covers both a malformed name and one already taken, possibly by
   * another Lettermint team or another deployment on this one. A registration this deployment
   * holds is already registered; one the team holds for anyone else is held elsewhere.
   */
  private async refusalFor(name: string, error: LettermintApiError): Promise<"already_registered" | "held_elsewhere" | "invalid_domain"> {
    if (!error.fieldNames.includes("domain")) {
      return "invalid_domain";
    }
    const listing = await this.findListedByName(name);
    if (!listing) {
      return "invalid_domain";
    }
    return this.isOwn(await this.readDomain(listing.id)) ? "already_registered" : "held_elsewhere";
  }

  private async providerDomainOf(domain: LettermintDomain): Promise<ProviderDomain> {
    return {
      providerDomainId: domain.id,
      region: null,
      readiness: readinessOf(domain, await this.findReceivingRoute(domain.name)),
    };
  }

  /**
   * A new domain is unrestricted, so any project on the team could send from it. When the
   * restriction fails the registration is deleted again, best effort, so a retry is not refused
   * by a name the team holds unrestricted; the restriction's failure is the one reported.
   */
  private async restrictToProject(providerDomainId: string): Promise<void> {
    try {
      await this.options.api.request("team", "PUT", `${domainPath(providerDomainId)}/projects`, {
        body: { project_ids: [this.options.projectId] },
      });
    } catch (error) {
      await this.options.api.request("team", "DELETE", domainPath(providerDomainId)).catch(() => undefined);
      throw error;
    }
  }

  private isOwn(domain: LettermintDomain): boolean {
    return domain.projectIds.includes(this.options.projectId);
  }

  private async readDomain(providerDomainId: string): Promise<LettermintDomain> {
    return parseDomain(
      await this.options.api.request("team", "GET", `${domainPath(providerDomainId)}?include=dnsRecords,projects`),
    );
  }

  private async findReceivingRoute(domain: string): Promise<LettermintReceivingRoute | null> {
    const slug = receivingRouteSlug(domain);
    const listing = await this.findListed(
      `/projects/${encodeURIComponent(this.options.projectId)}/routes`,
      { "filter[route_type]": "inbound", "filter[search]": slug },
      (entry) => entry.slug === slug,
    );
    if (!listing) {
      return null;
    }
    const route = parseRoute(await this.options.api.request("team", "GET", routePath(listing.id)));
    return route.inboundDomain === domain ? route : null;
  }

  private async createReceivingRoute(domain: string): Promise<LettermintReceivingRoute> {
    try {
      const created = await this.options.api.request("team", "POST", `/projects/${encodeURIComponent(this.options.projectId)}/routes`, {
        body: {
          name: domain,
          slug: receivingRouteSlug(domain),
          route_type: "inbound",
          inbound_domain: domain,
          // The route's spam filter is off without a threshold, and the channel judges no mail
          // again (see the inbound receiver), so every route Radioso makes sets Lettermint's default.
          inbound_spam_threshold: INBOUND_SPAM_THRESHOLD,
          attachment_delivery: "url",
        },
      });
      return parseRoute(isRecord(created) ? created.data : null);
    } catch (error) {
      // A concurrent request may have created the route first; its create refuses the slug.
      const existing = error instanceof LettermintApiError && error.kind === "rejected"
        ? await this.findReceivingRoute(domain)
        : null;
      if (existing) {
        return existing;
      }
      throw error;
    }
  }

  /** Follows a cursor-paginated listing until `matches` finds an entry. */
  private async findListed(
    path: string,
    filters: Readonly<Record<string, string>>,
    matches: (entry: Record<string, unknown>) => boolean,
  ): Promise<{ id: string } | null> {
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const query = new URLSearchParams(filters);
      if (cursor !== null) {
        query.set("page[cursor]", cursor);
      }
      const page = parsePage(await this.options.api.request("team", "GET", `${path}?${query.toString()}`));
      const match = page.entries.find(matches);
      if (match) {
        return match;
      }
      if (page.nextCursor === null || seen.has(page.nextCursor)) {
        return null;
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
}

const domainPath = (providerDomainId: string): string => `/domains/${encodeURIComponent(providerDomainId)}`;
const routePath = (routeId: string): string => `/routes/${encodeURIComponent(routeId)}`;

/** Structural and stable: the same domain always names the same route, and no domain shares it. */
const receivingRouteSlug = (domain: string): string =>
  `${ROUTE_SLUG_PREFIX}${createHash("sha256").update(domain).digest("hex").slice(0, ROUTE_SLUG_HASH_LENGTH)}`;

const isNotFound = (error: unknown): boolean => error instanceof LettermintApiError && error.kind === "not_found";

const ignoringNotFound = async (call: Promise<unknown>): Promise<void> => {
  try {
    await call;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
};

/** A verification check answers 422 while records do not resolve yet; readiness reports that. */
const requestedCheck = async (call: Promise<unknown>): Promise<void> => {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof LettermintApiError && error.statusCode === 422)) throw error;
  }
};

const readinessOf = (domain: LettermintDomain, route: LettermintReceivingRoute | null): DomainReadiness => {
  const records = domain.records.flatMap((record) => {
    const view = recordViewOf(record);
    return view ? [view] : [];
  });
  return {
    sending: sendingStatus(domain.records),
    receiving: route ? receivingStatus(route) : "not_requested",
    records: route ? [...records, receivingMxRecord(domain.name, route)] : records,
  };
};

const RECORD_STATUS: ReadonlyMap<string, ReadinessStatus> = new Map([
  ["active", "verified"],
  ["failed", "failed"],
  ["pending", "pending"],
]);

/** A single domain read carries no status, so sending readiness is read from the records verification requires. */
const sendingStatus = (records: readonly LettermintDnsRecord[]): ReadinessStatus => {
  const statuses = records.filter((record) => record.required).map((record) => RECORD_STATUS.get(record.status) ?? "pending");
  if (statuses.includes("failed")) {
    return "failed";
  }
  return statuses.length > 0 && statuses.every((status) => status === "verified") ? "verified" : "pending";
};

const receivingStatus = (route: LettermintReceivingRoute): ReadinessStatus => (route.verified ? "verified" : "pending");

const receivingMxRecord = (domain: string, route: LettermintReceivingRoute): DnsRecordView => ({
  purpose: "receiving_mx",
  type: "MX",
  name: domain,
  value: route.mxHostname ?? DEFAULT_MX_HOSTNAME,
  priority: RECEIVING_MX_PRIORITY,
  status: receivingStatus(route),
});

const RECORD_PURPOSE: ReadonlyMap<string, DnsRecordView["purpose"]> = new Map([
  ["dkim_primary", "dkim"],
  ["dkim_secondary", "dkim"],
  ["dkim_legacy", "dkim"],
  ["return_path", "return_path"],
  ["dmarc", "dmarc"],
]);

/** A record verification does not require is advisory until it resolves. */
const recordViewOf = (record: LettermintDnsRecord): DnsRecordView | null => {
  const purpose = RECORD_PURPOSE.get(record.purpose);
  if (!purpose || !isRecordType(record.type)) {
    return null;
  }
  const status = RECORD_STATUS.get(record.status) ?? "pending";
  return {
    purpose,
    type: record.type,
    name: record.name,
    value: record.value,
    status: record.required || status === "verified" ? status : "advisory",
  };
};

const isRecordType = (type: string): type is DnsRecordView["type"] =>
  type === "TXT" || type === "MX" || type === "CNAME";

const malformed = (): LettermintApiError => new LettermintApiError("malformed_response", null, null);

const parseDomain = (payload: unknown): LettermintDomain => {
  if (!isRecord(payload) || typeof payload.id !== "string" || typeof payload.domain !== "string") {
    throw malformed();
  }
  return {
    id: payload.id,
    name: payload.domain.toLowerCase(),
    records: Array.isArray(payload.dns_records) ? payload.dns_records.flatMap(parseRecord) : [],
    // A domain read without its projects reads as unrestricted, so it is never taken for this deployment's.
    projectIds: Array.isArray(payload.projects)
      ? payload.projects.flatMap((project: unknown) => (isRecord(project) && typeof project.id === "string" ? [project.id] : []))
      : [],
  };
};

const parseRecord = (value: unknown): LettermintDnsRecord[] => {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.content !== "string") {
    return [];
  }
  const name = typeof value.fqdn === "string" ? value.fqdn : value.hostname;
  if (typeof name !== "string") {
    return [];
  }
  return [
    {
      type: value.type,
      name,
      value: value.content,
      status: typeof value.status === "string" ? value.status : "",
      purpose: typeof value.purpose === "string" ? value.purpose : "",
      required: value.required_for_verification === true,
    },
  ];
};

const parseRoute = (payload: unknown): LettermintReceivingRoute => {
  if (!isRecord(payload) || typeof payload.id !== "string") {
    throw malformed();
  }
  return {
    id: payload.id,
    inboundDomain: typeof payload.inbound_domain === "string" ? payload.inbound_domain.toLowerCase() : null,
    mxHostname: typeof payload.inbound_mx_hostname === "string" && payload.inbound_mx_hostname ? payload.inbound_mx_hostname : null,
    verified: typeof payload.inbound_domain_verified_at === "string",
  };
};

const parsePage = (payload: unknown): { entries: ({ id: string } & Record<string, unknown>)[]; nextCursor: string | null } => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw malformed();
  }
  return {
    entries: payload.data.flatMap((entry: unknown) =>
      isRecord(entry) && typeof entry.id === "string" ? [{ ...entry, id: entry.id }] : []),
    nextCursor: typeof payload.next_cursor === "string" && payload.next_cursor ? payload.next_cursor : null,
  };
};
