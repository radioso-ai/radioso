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

/** A domain as the provider holds it: its id, its region and its readiness now. */
export interface ProviderDomain {
  providerDomainId: string;
  region: string | null;
  readiness: DomainReadiness;
  /** When the provider created the registration, by its clock; null when it does not say. */
  createdAt: Date | null;
}

/**
 * `already_registered`: the provider holds the name already. The provider cannot say for which
 * workspace; the caller's own registration claim decides, and `findByName` recovers it.
 */
export type DomainRegistration =
  | ({ ok: true } & ProviderDomain)
  | { ok: false; refused: "already_registered" | "invalid_domain" };

export interface EmailDomainProvisioner {
  readonly provider: string;
  registerSendingDomain(domain: string): Promise<DomainRegistration>;
  /**
   * The registration of `domain` this deployment's provider account and region hold, or null.
   * Recovers a registration whose create was accepted but whose answer never arrived. The account
   * can hold registrations no workspace made, so `createdAt` is what ties one to an attempt.
   */
  findByName(domain: string): Promise<ProviderDomain | null>;
  enableReceiving(providerDomainId: string): Promise<DomainReadiness>;
  requestVerification(providerDomainId: string): Promise<void>;
  readiness(input: { providerDomainId: string; domain: string }): Promise<DomainReadiness>;
  remove(providerDomainId: string): Promise<void>;
}
