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
  "findCredentialByHash" | "findCredential" | "findServiceAccount" | "touchCredentialUse"
>;

type MachineApiPrincipal = Extract<
  AuthenticatedPrincipal,
  { type: "personal_api_credential" | "service_account_credential" }
>;

type ApiCredential = NonNullable<Awaited<ReturnType<ApiPrincipalRepository["findCredential"]>>>;

/** A credential's principal now, or why it has none. */
type CredentialResolution =
  | { ok: true; accountId: string; workspaceId: string; principal: MachineApiPrincipal }
  | { ok: false; kind: "personal" | "service"; reason: Exclude<MachineAccessAuthenticationReason, "authenticated"> };

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
    const resolved = await this.resolve(credential);
    if (!resolved.ok) return this.deny(resolved.kind, resolved.reason);
    this.observe({ outcome: "success", principalKind: credential.kind, reason: "authenticated" });
    return { accountId: resolved.accountId, workspaceId: resolved.workspaceId, principal: resolved.principal };
  }

  /**
   * The principal a stored credential acts as right now, checked exactly as a request presenting
   * it would be, or null when that request would be refused. For work a credential started that
   * runs later without it being presented (an event subscription's pushes). Records no authentication.
   */
  async principalForCredential(credentialId: string): Promise<{ accountId: string; workspaceId: string; principal: MachineApiPrincipal } | null> {
    const credential = await this.input.repository.findCredential(credentialId);
    if (!credential) return null;
    const resolved = await this.resolve(credential);
    return resolved.ok ? { accountId: resolved.accountId, workspaceId: resolved.workspaceId, principal: resolved.principal } : null;
  }

  private async resolve(credential: ApiCredential): Promise<CredentialResolution> {
    const kind = credential.kind;
    if (credential.revokedAt) return { ok: false, kind, reason: "revoked" };
    if (credential.expiresAt && credential.expiresAt.getTime() <= this.now().getTime()) return { ok: false, kind, reason: "expired" };
    if (credential.kind === "personal") {
      if (!credential.ownerUserId || !credential.accessTenureMembershipId || !credential.roleCeiling) return { ok: false, kind, reason: "personal_binding_invalid" };
      const membership = await this.input.accountAccess.findActiveMembershipById(credential.accessTenureMembershipId);
      if (!membership || membership.userId !== credential.ownerUserId || membership.accountId !== credential.accountId) return { ok: false, kind, reason: "personal_membership_inactive" };
      const liveRole = await this.input.accountAccess.resolveWorkspaceRole({ accountId: membership.accountId, userId: membership.userId, workspaceId: credential.workspaceId });
      if (!liveRole) return { ok: false, kind, reason: "personal_role_unavailable" };
      return { ok: true, accountId: membership.accountId, workspaceId: credential.workspaceId, principal: { type: "personal_api_credential", userId: credential.ownerUserId, credentialId: credential.id, role: minimumRole(credential.roleCeiling, liveRole === "owner" ? "admin" : liveRole), workspaceId: credential.workspaceId } };
    }
    if (!credential.serviceAccountId) return { ok: false, kind, reason: "service_binding_invalid" };
    const account = await this.input.repository.findServiceAccount(credential.serviceAccountId);
    if (!account || account.accountId !== credential.accountId || account.workspaceId !== credential.workspaceId) return { ok: false, kind, reason: "service_binding_invalid" };
    if (account.status !== "enabled") return { ok: false, kind, reason: "service_account_disabled" };
    return { ok: true, accountId: account.accountId, workspaceId: credential.workspaceId, principal: { type: "service_account_credential", serviceAccountId: account.id, credentialId: credential.id, role: account.role, workspaceId: credential.workspaceId } };
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
