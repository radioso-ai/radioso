import type {
  DnsRecordView,
  DomainReadiness,
  DomainRegistration,
  EmailDomainProvisioner,
  ReadinessStatus,
} from "../emailDomainProvisioner.js";
import { normalizeDomainName } from "./dnsDomainName.js";
import { ResendApiError, isRecord, type ResendApiClient } from "./resendApi.js";

/**
 * Registers a workspace's own domain with Resend (research A4): created in the deployment's
 * region with open and click tracking off, sending on, and receiving only when the advanced
 * direct-receiving option asks for it. Resend returns no DMARC record, so a recommended `p=none`
 * record is added and checked with a DNS lookup; it is advisory and never gates sending.
 */

/** `node:dns/promises` `resolveTxt` shape: one array of character-strings per TXT record. */
export type TxtResolver = (hostname: string) => Promise<string[][]>;

interface ResendDomainProvisionerOptions {
  api: ResendApiClient;
  region: string;
  resolveTxt: TxtResolver;
}

interface ResendDnsRecord {
  kind: string;
  name: string;
  type: string;
  value: string;
  priority: number | null;
  status: string;
}

interface ResendDomain {
  id: string;
  name: string;
  status: string;
  region: string | null;
  sendingEnabled: boolean;
  receivingEnabled: boolean;
  records: readonly ResendDnsRecord[];
}

const RECOMMENDED_DMARC_VALUE = "v=DMARC1; p=none;";
const DMARC_TAG = "v=dmarc1";
const DKIM_LABEL = "._domainkey";

export class ResendEmailDomainProvisioner implements EmailDomainProvisioner {
  readonly provider = "resend";

  constructor(private readonly options: ResendDomainProvisionerOptions) {}

  async registerSendingDomain(domain: string): Promise<DomainRegistration> {
    const name = normalizeDomainName(domain);
    if (!name) {
      return { ok: false, refused: "invalid_domain" };
    }
    let payload: unknown;
    try {
      payload = await this.options.api.request("POST", "/domains", {
        body: {
          name,
          region: this.options.region,
          open_tracking: false,
          click_tracking: false,
          capabilities: { sending: "enabled", receiving: "disabled" },
        },
      });
    } catch (error) {
      const refused = registrationRefusal(error);
      if (refused) {
        return { ok: false, refused };
      }
      throw error;
    }
    const created = parseDomain(payload);
    return {
      ok: true,
      providerDomainId: created.id,
      region: created.region,
      readiness: await this.readinessOf(created),
    };
  }

  async enableReceiving(providerDomainId: string): Promise<DomainReadiness> {
    await this.options.api.request("PATCH", domainPath(providerDomainId), {
      body: { capabilities: { sending: "enabled", receiving: "enabled" } },
    });
    return this.readinessOf(await this.readDomain(providerDomainId));
  }

  async requestVerification(providerDomainId: string): Promise<void> {
    await this.options.api.request("POST", `${domainPath(providerDomainId)}/verify`);
  }

  async readiness(input: { providerDomainId: string; domain: string }): Promise<DomainReadiness> {
    return this.readinessOf(await this.readDomain(input.providerDomainId));
  }

  async remove(providerDomainId: string): Promise<void> {
    try {
      await this.options.api.request("DELETE", domainPath(providerDomainId));
    } catch (error) {
      if (error instanceof ResendApiError && error.kind === "not_found") {
        return;
      }
      throw error;
    }
  }

  private async readDomain(providerDomainId: string): Promise<ResendDomain> {
    return parseDomain(await this.options.api.request("GET", domainPath(providerDomainId)));
  }

  private async readinessOf(domain: ResendDomain): Promise<DomainReadiness> {
    const providerRecords = domain.records.flatMap((record) => {
      const view = recordViewOf(record);
      return view ? [view] : [];
    });
    return {
      sending: domain.sendingEnabled ? capabilityStatus(domain.status, providerRecords, SENDING_PURPOSES) : "pending",
      receiving: domain.receivingEnabled
        ? capabilityStatus(domain.status, providerRecords, RECEIVING_PURPOSES)
        : "not_requested",
      records: [...providerRecords, await this.dmarcRecord(domain, providerRecords)],
    };
  }

  private async dmarcRecord(domain: ResendDomain, records: readonly DnsRecordView[]): Promise<DnsRecordView> {
    return {
      purpose: "dmarc",
      type: "TXT",
      name: dmarcRecordName(domain.name, records),
      value: RECOMMENDED_DMARC_VALUE,
      status: (await this.hasDmarcRecord(domain.name)) ? "verified" : "advisory",
    };
  }

  private async hasDmarcRecord(domain: string): Promise<boolean> {
    try {
      const records = await this.options.resolveTxt(`_dmarc.${domain}`);
      return records.some((chunks) => chunks.join("").trim().toLowerCase().startsWith(DMARC_TAG));
    } catch {
      return false;
    }
  }
}

const domainPath = (providerDomainId: string): string => `/domains/${encodeURIComponent(providerDomainId)}`;

/**
 * Resend answers a create for a name already registered on the account with `403
 * validation_error`; one account serves every workspace in a region, so that is a claim held
 * elsewhere (AS1.4). A 422 is Resend refusing the name itself.
 */
const registrationRefusal = (error: unknown): "claimed_elsewhere" | "invalid_domain" | null => {
  if (!(error instanceof ResendApiError)) {
    return null;
  }
  if (error.statusCode === 403 && error.providerErrorName === "validation_error") {
    return "claimed_elsewhere";
  }
  return error.statusCode === 422 ? "invalid_domain" : null;
};

const SENDING_PURPOSES: ReadonlySet<DnsRecordView["purpose"]> = new Set(["dkim", "spf", "return_path"]);
const RECEIVING_PURPOSES: ReadonlySet<DnsRecordView["purpose"]> = new Set(["receiving_mx"]);

const DOMAIN_STATUS: ReadonlyMap<string, ReadinessStatus> = new Map([
  ["verified", "verified"],
  ["failed", "failed"],
  ["pending", "pending"],
  ["not_started", "pending"],
  ["temporary_failure", "pending"],
]);

const PARTIAL_DOMAIN_STATUSES: ReadonlySet<string> = new Set(["partially_verified", "partially_failed"]);

/** A partial domain status says nothing per capability, so the capability's own records decide. */
const capabilityStatus = (
  domainStatus: string,
  records: readonly DnsRecordView[],
  purposes: ReadonlySet<DnsRecordView["purpose"]>,
): ReadinessStatus => {
  if (!PARTIAL_DOMAIN_STATUSES.has(domainStatus)) {
    return DOMAIN_STATUS.get(domainStatus) ?? "pending";
  }
  const statuses = records.filter((record) => purposes.has(record.purpose)).map((record) => record.status);
  if (statuses.includes("failed")) {
    return "failed";
  }
  return statuses.length > 0 && statuses.every((status) => status === "verified") ? "verified" : "pending";
};

const recordViewOf = (record: ResendDnsRecord): DnsRecordView | null => {
  const purpose = recordPurpose(record);
  if (!purpose || !isRecordType(record.type)) {
    return null;
  }
  return {
    purpose,
    type: record.type,
    name: record.name,
    value: record.value,
    ...(record.priority === null ? {} : { priority: record.priority }),
    status: DOMAIN_STATUS.get(record.status) ?? "pending",
  };
};

/** Resend's `record` field: `DKIM`, `SPF` (an MX for the return path and a TXT), `Receiving`. */
const recordPurpose = (record: ResendDnsRecord): DnsRecordView["purpose"] | null => {
  switch (record.kind) {
    case "DKIM":
      return "dkim";
    case "SPF":
      return record.type === "MX" ? "return_path" : "spf";
    case "Receiving":
      return "receiving_mx";
    default:
      return null;
  }
};

const isRecordType = (type: string): type is DnsRecordView["type"] =>
  type === "TXT" || type === "MX" || type === "CNAME";

/**
 * Resend names records relative to the registrable domain (`resend._domainkey.s0-email-channel`
 * for `s0-email-channel.radioso.ai`). The DMARC name follows the same convention, taking the
 * relative suffix from the DKIM record; without one it falls back to the full name.
 */
const dmarcRecordName = (domain: string, records: readonly DnsRecordView[]): string => {
  const dkimName = records.find((record) => record.purpose === "dkim")?.name;
  const labelAt = dkimName?.indexOf(DKIM_LABEL) ?? -1;
  if (dkimName === undefined || labelAt < 0) {
    return `_dmarc.${domain}`;
  }
  return `_dmarc${dkimName.slice(labelAt + DKIM_LABEL.length)}`;
};

const parseDomain = (payload: unknown): ResendDomain => {
  if (!isRecord(payload) || typeof payload.id !== "string" || typeof payload.name !== "string") {
    throw new ResendApiError("malformed_response", null, null);
  }
  const capabilities = isRecord(payload.capabilities) ? payload.capabilities : {};
  return {
    id: payload.id,
    name: payload.name,
    status: typeof payload.status === "string" ? payload.status : "",
    region: typeof payload.region === "string" ? payload.region : null,
    sendingEnabled: capabilities.sending === "enabled",
    receivingEnabled: capabilities.receiving === "enabled",
    records: Array.isArray(payload.records) ? payload.records.flatMap(parseRecord) : [],
  };
};

const parseRecord = (value: unknown): ResendDnsRecord[] => {
  if (
    !isRecord(value) ||
    typeof value.record !== "string" ||
    typeof value.name !== "string" ||
    typeof value.type !== "string" ||
    typeof value.value !== "string"
  ) {
    return [];
  }
  return [
    {
      kind: value.record,
      name: value.name,
      type: value.type,
      value: value.value,
      priority: typeof value.priority === "number" ? value.priority : null,
      status: typeof value.status === "string" ? value.status : "",
    },
  ];
};
