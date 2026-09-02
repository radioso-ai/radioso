import type { AuditService } from "../../audit/contracts/index.js";
import type { PersonalCredentialTenureEndReason } from "../domain.js";
import type { ApiCredentialRecord, MachineAccessAuditEvent, MachineAccessPersistencePort } from "../ports.js";
import { machineAccessAuditEvent } from "../auditMetadata.js";

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
      auditEvents: (credentials) => this.invalidationEvents(input.accountId, credentials, input.actorUserId, input.reason ?? "membership_ended"),
    });
    this.logCommitted(this.invalidationEvents(input.accountId, credentials, input.actorUserId, input.reason ?? "membership_ended"));
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
      auditEvents: (credentials) => this.invalidationEvents(input.accountId, credentials, input.actorUserId, reason),
    });
    this.logCommitted(this.invalidationEvents(input.accountId, credentials, input.actorUserId, reason));
  }

  async endAccount(input: { accountId: string; actorUserId?: string | null }): Promise<void> {
    const credentials = await this.input.repository.invalidatePersonalCredentialsForAccount({
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      reason: "account_deleted",
      now: this.now(),
      auditEvents: (credentials) => this.invalidationEvents(input.accountId, credentials, input.actorUserId, "account_deleted"),
    });
    this.logCommitted(this.invalidationEvents(input.accountId, credentials, input.actorUserId, "account_deleted"));
  }

  private now(): Date {
    return (this.input.now ?? (() => new Date()))();
  }

  private invalidationEvents(
    accountId: string,
    credentials: ApiCredentialRecord[],
    actorUserId: string | null | undefined,
    reason: PersonalCredentialTenureEndReason,
  ): MachineAccessAuditEvent[] {
    return credentials.map((credential) => machineAccessAuditEvent({
        accountId,
        workspaceId: credential.workspaceId,
        eventType: "machine_access.personal_credential.invalidated",
        eventStatus: "success",
        metadata: {
          actorUserId: actorUserId ?? null,
          credentialId: credential.id,
          principalKind: "user",
          principalId: credential.ownerUserId,
          reason,
          systemInitiated: actorUserId == null,
        },
      }));
  }

  private logCommitted(events: readonly MachineAccessAuditEvent[]): void {
    for (const event of events) this.input.audit.logRecorded?.(event);
  }
}
