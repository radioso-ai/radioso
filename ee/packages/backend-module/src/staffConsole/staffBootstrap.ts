import { HttpError } from "../shared/httpError.js";
import { hashStaffPassword } from "./staffCrypto.js";
import type { StaffSessionRepository, StaffUserRepository } from "./staffRepository.js";
import type { StaffSecurityEvents } from "./staffSecurityEvents.js";
import type { StaffUser } from "./staffTypes.js";

export interface StaffBootstrapResult {
  staff: StaffUser;
  action: "create_owner" | "reset_owner";
  revokedSessions: number;
}

/**
 * Creates the first owner, or recovers a locked-out one. Reachable only from
 * staffBootstrapCli.ts, by someone who already holds the database credential.
 */
export class StaffBootstrapService {
  constructor(
    private readonly users: StaffUserRepository,
    private readonly sessions: Pick<StaffSessionRepository, "revokeAllForStaff">,
    private readonly events: Pick<StaffSecurityEvents, "privilegedChange">,
  ) {}

  async bootstrapOwner(input: { email: string; name: string; password: string }): Promise<StaffBootstrapResult> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.users.findByEmail(email);
    const passwordHash = await hashStaffPassword(input.password);
    const result = existing
      ? await this.resetExistingOwner(existing, passwordHash)
      : {
        staff: await this.users.create({
          email,
          name: input.name.trim(),
          passwordHash,
          role: "owner",
          status: "active",
        }),
        action: "create_owner" as const,
        revokedSessions: 0,
      };

    await this.events.privilegedChange({
      eventType: "staff.bootstrap",
      metadata: {
        actor: "staff.bootstrap",
        targetStaffId: result.staff.id,
        action: result.action,
        revokedSessions: result.revokedSessions,
      },
    });

    return result;
  }

  private async resetExistingOwner(existing: StaffUser, passwordHash: string): Promise<StaffBootstrapResult> {
    if (existing.role !== "owner") {
      throw new HttpError(409, "staff_bootstrap_conflict", "Bootstrap can only reset an existing owner.");
    }
    const staff = await this.users.updatePassword(existing.id, passwordHash);
    if (!staff) {
      throw new HttpError(404, "not_found", "Staff owner not found.");
    }
    // A reset exists because the old credential can no longer be trusted, so nothing it opened survives.
    const revokedSessions = await this.sessions.revokeAllForStaff(existing.id);
    return { staff, action: "reset_owner", revokedSessions };
  }
}
