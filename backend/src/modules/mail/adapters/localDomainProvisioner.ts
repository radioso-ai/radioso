import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  DnsRecordView,
  DomainReadiness,
  DomainRegistration,
  EmailDomainProvisioner,
  ReadinessStatus,
} from "../emailDomainProvisioner.js";
import { normalizeDomainName } from "./dnsDomainName.js";
import { isRecord } from "./resendApi.js";

/**
 * Local development and test stand-in for a domain provider. It returns fixed DNS records in
 * `pending` and keeps each domain's state as a small JSON file under
 * `${spoolDir}/domains/`, so the API and worker processes share it. Nothing verifies a local
 * domain on its own: the dev tool (`email:dev verify-domain <domain>`) calls `markVerified`.
 */

interface LocalDomainProvisionerOptions {
  spoolDir: string;
}

interface LocalDomainState {
  receivingRequested: boolean;
  verified: boolean;
}

const PROVIDER_ID_PREFIX = "local:";
const UNREGISTERED: LocalDomainState = { receivingRequested: false, verified: false };

export class LocalEmailDomainProvisioner implements EmailDomainProvisioner {
  readonly provider = "local";

  constructor(private readonly options: LocalDomainProvisionerOptions) {}

  async registerSendingDomain(domain: string): Promise<DomainRegistration> {
    const name = normalizeDomainName(domain);
    if (!name) {
      return { ok: false, refused: "invalid_domain" };
    }
    const state = await this.readState(name);
    await this.writeState(name, state);
    return {
      ok: true,
      providerDomainId: `${PROVIDER_ID_PREFIX}${name}`,
      region: null,
      readiness: readinessOf(name, state),
    };
  }

  async enableReceiving(providerDomainId: string): Promise<DomainReadiness> {
    const name = domainOf(providerDomainId);
    const state = { ...(await this.readState(name)), receivingRequested: true };
    await this.writeState(name, state);
    return readinessOf(name, state);
  }

  /** Local domains verify only through `markVerified`. */
  async requestVerification(providerDomainId: string): Promise<void> {
    domainOf(providerDomainId);
  }

  async readiness(input: { providerDomainId: string; domain: string }): Promise<DomainReadiness> {
    const name = domainOf(input.providerDomainId);
    return readinessOf(name, await this.readState(name));
  }

  async remove(providerDomainId: string): Promise<void> {
    await rm(this.statePath(domainOf(providerDomainId)), { force: true });
  }

  /** Flips every record of a local domain to verified, as DNS propagation would. */
  async markVerified(domain: string): Promise<void> {
    const name = normalizeDomainName(domain);
    if (!name) {
      throw new Error("Not a valid domain name");
    }
    await this.writeState(name, { ...(await this.readState(name)), verified: true });
  }

  private statePath(domain: string): string {
    return join(this.options.spoolDir, "domains", `${domain}.json`);
  }

  private async readState(domain: string): Promise<LocalDomainState> {
    let text: string;
    try {
      text = await readFile(this.statePath(domain), "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return UNREGISTERED;
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    return {
      receivingRequested: isRecord(parsed) && parsed.receivingRequested === true,
      verified: isRecord(parsed) && parsed.verified === true,
    };
  }

  private async writeState(domain: string, state: LocalDomainState): Promise<void> {
    await mkdir(join(this.options.spoolDir, "domains"), { recursive: true });
    await writeFile(this.statePath(domain), JSON.stringify(state));
  }
}

const domainOf = (providerDomainId: string): string => {
  const name = providerDomainId.startsWith(PROVIDER_ID_PREFIX)
    ? normalizeDomainName(providerDomainId.slice(PROVIDER_ID_PREFIX.length))
    : null;
  if (!name) {
    throw new Error("Not a local provider domain id");
  }
  return name;
};

const readinessOf = (domain: string, state: LocalDomainState): DomainReadiness => {
  const status: ReadinessStatus = state.verified ? "verified" : "pending";
  const receiving: DnsRecordView[] = state.receivingRequested
    ? [{ purpose: "receiving_mx", type: "MX", name: domain, value: "inbound.localhost.test", priority: 10, status }]
    : [];
  return {
    sending: status,
    receiving: state.receivingRequested ? status : "not_requested",
    records: [
      { purpose: "dkim", type: "TXT", name: `local._domainkey.${domain}`, value: "p=LOCALDEVELOPMENTKEY", status },
      { purpose: "spf", type: "TXT", name: `send.${domain}`, value: "v=spf1 include:localhost.test ~all", status },
      { purpose: "return_path", type: "MX", name: `send.${domain}`, value: "feedback.localhost.test", priority: 10, status },
      ...receiving,
      { purpose: "dmarc", type: "TXT", name: `_dmarc.${domain}`, value: "v=DMARC1; p=none;", status: "advisory" },
    ],
  };
};

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
