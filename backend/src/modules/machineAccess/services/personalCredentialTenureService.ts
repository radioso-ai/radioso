import type { AuditService } from "../../audit/contracts/index.js";
import type { PersonalCredentialTenureEndReason } from "../domain.js";
import type { ApiCredentialRecord, MachineAccessPersistencePort } from "../ports.js";
import { machineAccessAuditMetadata } from "../auditMetadata.js";

type TenureRepository = Pick<
  MachineAccessPersistencePort,
  "invalidatePersonalCredentialsForTenure" | "invalidatePersonalCredentialsForWorkspace"
  | "invalidatePersonalCredentialsForAccount"
>;

/** Ends personal-credential authority when its human access tenure ends. */
export class PersonalCredentialTenureService {
  constructor(private readonly input: { repository: TenureRepository; audit: AuditService; now?: () => Date }) {}

  async endMembership(input: {
    accountId: string;
    membershipId: string;
    actorUserId?: string | null;
    reason?: Extract<PersonalCredentialTenureEndReason, "membership_ended" | "user_deleted">;
  }): Promise<void> {
    const credentials = await this.input.repository.invalidatePersonalCredentialsForTenure({
      membershipId: input.membershipId,
      actorUserId: input.actorUserId,
      reason: input.reason ?? "membership_ended",
      now: this.now(),
    });
    await this.recordInvalidations(input.accountId, credentials, input.actorUserId, input.reason ?? "membership_ended");
  }

  async endWorkspace(input: {
    accountId: string;
    workspaceId: string;
    actorUserId?: string | null;
    reason?: Extract<PersonalCredentialTenureEndReason, "workspace_deleted" | "account_deleted">;
  }): Promise<void> {
    const reason = input.reason ?? "workspace_deleted";
    const credentials = await this.input.repository.invalidatePersonalCredentialsForWorkspace({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      reason,
      now: this.now(),
    });
    await this.recordInvalidations(input.accountId, credentials, input.actorUserId, reason);
  }

  async endAccount(input: { accountId: string; actorUserId?: string | null }): Promise<void> {
    const credentials = await this.input.repository.invalidatePersonalCredentialsForAccount({
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      reason: "account_deleted",
      now: this.now(),
    });
    await this.recordInvalidations(input.accountId, credentials, input.actorUserId, "account_deleted");
  }

  private now(): Date {
    return (this.input.now ?? (() => new Date()))();
  }

  private async recordInvalidations(
    accountId: string,
    credentials: ApiCredentialRecord[],
    actorUserId: string | null | undefined,
    reason: PersonalCredentialTenureEndReason,
  ): Promise<void> {
    for (const credential of credentials) {
      await this.input.audit.record({
        accountId,
        workspaceId: credential.workspaceId,
        eventType: "machine_access.personal_credential.invalidated",
        eventStatus: "success",
        metadata: machineAccessAuditMetadata({
          actorUserId: actorUserId ?? null,
          credentialId: credential.id,
          principalKind: "user",
          principalId: credential.ownerUserId,
          reason,
          systemInitiated: actorUserId == null,
        }),
      });
    }
  }
}
