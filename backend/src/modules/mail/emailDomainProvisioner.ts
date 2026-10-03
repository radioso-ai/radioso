/**
 * Provider port for registering a workspace's own sending and receiving domain and reading back
 * the DNS records the operator must publish. Provider- and transport-only.
 *
 * Consumer: `emailChannel/domains/sendingDomainService.ts` only.
 */

export type ReadinessStatus = "pending" | "verified" | "failed";

export interface DnsRecordView {
  purpose: "dkim" | "spf" | "return_path" | "receiving_mx" | "dmarc";
  type: "TXT" | "MX" | "CNAME";
  name: string;
  value: string;
  priority?: number;
  status: ReadinessStatus | "advisory";
}

export interface DomainReadiness {
  sending: ReadinessStatus;
  receiving: ReadinessStatus | "not_requested";
  records: readonly DnsRecordView[];
}

export type DomainRegistration =
  | { ok: true; providerDomainId: string; region: string | null; readiness: DomainReadiness }
  | { ok: false; refused: "claimed_elsewhere" | "invalid_domain" };

export interface EmailDomainProvisioner {
  readonly provider: string;
  registerSendingDomain(domain: string): Promise<DomainRegistration>;
  enableReceiving(providerDomainId: string): Promise<DomainReadiness>;
  requestVerification(providerDomainId: string): Promise<void>;
  readiness(input: { providerDomainId: string; domain: string }): Promise<DomainReadiness>;
  remove(providerDomainId: string): Promise<void>;
}
