import { unauthorized } from "../../../shared/domain/errors.js";
import type { AccountAccessService, AuthenticatedPrincipal } from "../../account/public.js";
import type {
  MachineAccessAuthenticationReason,
  MachineAccessPersistencePort,
  MachineAccessSecurityObserver,
} from "../ports.js";
import { hashMachineSecret } from "../credentialSecretCodec.js";
import { minimumRole } from "../domain.js";

type ApiPrincipalRepository = Pick<
  MachineAccessPersistencePort,
  "findCredentialByHash" | "findServiceAccount" | "touchCredentialUse"
>;

type MachineApiPrincipal = Extract<
  AuthenticatedPrincipal,
  { type: "personal_api_credential" | "service_account_credential" }
>;

const presentedKind = (secret: string): "personal" | "service" | "unknown" => {
  if (/^radioso_pat_v1_[A-Za-z0-9_-]{43}$/.test(secret)) return "personal";
  if (/^radioso_svc_v1_[A-Za-z0-9_-]{43}$/.test(secret)) return "service";
  return "unknown";
};

export class ApiPrincipalAuthenticator {
  constructor(private readonly input: {
    repository: ApiPrincipalRepository;
    accountAccess: AccountAccessService;
    authenticationObserver?: Pick<MachineAccessSecurityObserver, "recordAuthentication" | "recordLastUsePersistenceFailure">;
    now?: () => Date;
  }) {}
  private now = () => (this.input.now ?? (() => new Date()))();

  async authenticate(secret: string): Promise<{ accountId: string; workspaceId: string; principal: AuthenticatedPrincipal }> {
    const secretKind = presentedKind(secret);
    let hash: string;
    try { hash = hashMachineSecret(secret); } catch { return this.deny(secretKind, "malformed"); }
    const credential = await this.input.repository.findCredentialByHash(hash);
    if (!credential) return this.deny(secretKind, "unknown");
    if (credential.kind !== secretKind) return this.deny(secretKind, credential.kind === "personal" ? "personal_binding_invalid" : "service_binding_invalid");
    if (credential.revokedAt) return this.deny(secretKind, "revoked");
    if (credential.expiresAt && credential.expiresAt.getTime() <= this.now().getTime()) return this.deny(secretKind, "expired");
    if (credential.kind === "personal") {
      if (!credential.ownerUserId || !credential.accessTenureMembershipId || !credential.roleCeiling) return this.deny("personal", "personal_binding_invalid");
      const membership = await this.input.accountAccess.findActiveMembershipById(credential.accessTenureMembershipId);
      if (!membership || membership.userId !== credential.ownerUserId || membership.accountId !== credential.accountId) return this.deny("personal", "personal_membership_inactive");
      const liveRole = await this.input.accountAccess.resolveWorkspaceRole({ accountId: membership.accountId, userId: membership.userId, workspaceId: credential.workspaceId });
      if (!liveRole) return this.deny("personal", "personal_role_unavailable");
      this.observe({ outcome: "success", principalKind: "personal", reason: "authenticated" });
      return { accountId: membership.accountId, workspaceId: credential.workspaceId, principal: { type: "personal_api_credential", userId: credential.ownerUserId, credentialId: credential.id, role: minimumRole(credential.roleCeiling, liveRole === "owner" ? "admin" : liveRole), workspaceId: credential.workspaceId } };
    }
    if (!credential.serviceAccountId) return this.deny("service", "service_binding_invalid");
    const account = await this.input.repository.findServiceAccount(credential.serviceAccountId);
    if (!account || account.accountId !== credential.accountId || account.workspaceId !== credential.workspaceId) return this.deny("service", "service_binding_invalid");
    if (account.status !== "enabled") return this.deny("service", "service_account_disabled");
    this.observe({ outcome: "success", principalKind: "service", reason: "authenticated" });
    return { accountId: account.accountId, workspaceId: credential.workspaceId, principal: { type: "service_account_credential", serviceAccountId: account.id, credentialId: credential.id, role: account.role, workspaceId: credential.workspaceId } };
  }

  recordSuccessfulUse(principal: MachineApiPrincipal): void {
    this.persistLastUse({
      credentialId: principal.credentialId,
      ...(principal.type === "service_account_credential" ? { serviceAccountId: principal.serviceAccountId } : {}),
      at: this.now(),
    });
  }

  private deny(
    principalKind: "personal" | "service" | "unknown",
    reason: Exclude<MachineAccessAuthenticationReason, "authenticated">,
  ): never {
    this.observe({ outcome: "denied", principalKind, reason });
    throw unauthorized();
  }

  private observe(input: Parameters<MachineAccessSecurityObserver["recordAuthentication"]>[0]): void {
    try {
      this.input.authenticationObserver?.recordAuthentication(input);
    } catch {
      // Authentication must not depend on telemetry availability.
    }
  }

  private persistLastUse(input: { credentialId: string; serviceAccountId?: string; at: Date }): void {
    try {
      void this.input.repository.touchCredentialUse(input).catch(() => this.observeLastUseFailure());
    } catch {
      this.observeLastUseFailure();
    }
  }

  private observeLastUseFailure(): void {
    try {
      this.input.authenticationObserver?.recordLastUsePersistenceFailure?.();
    } catch {
      // Authentication must not depend on telemetry availability.
    }
  }
}
