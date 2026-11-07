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
    if (existing) {
      return this.resetExistingOwner(existing, passwordHash);
    }

    const staff = await this.users.create({
      email,
      name: input.name.trim(),
      passwordHash,
      role: "owner",
      status: "active",
    });
    await this.recordChange(staff, "create_owner", 0);
    return { staff, action: "create_owner", revokedSessions: 0 };
  }

  private async resetExistingOwner(existing: StaffUser, passwordHash: string): Promise<StaffBootstrapResult> {
    if (existing.role !== "owner") {
      throw new HttpError(409, "staff_bootstrap_conflict", "Bootstrap can only reset an existing owner.");
    }
    const staff = await this.users.updatePassword(existing.id, passwordHash);
    if (!staff) {
      throw new HttpError(404, "not_found", "Staff owner not found.");
    }
    // A reset exists because the old credential can no longer be trusted, so nothing it opened
    // survives. The credential has already changed by now, so a failure here still gets recorded.
    let revokedSessions: number;
    try {
      revokedSessions = await this.sessions.revokeAllForStaff(existing.id);
    } catch (error) {
      await this.recordChange(staff, "reset_owner", null);
      throw error;
    }
    await this.recordChange(staff, "reset_owner", revokedSessions);
    return { staff, action: "reset_owner", revokedSessions };
  }

  private recordChange(
    staff: StaffUser,
    action: StaffBootstrapResult["action"],
    revokedSessions: number | null,
  ): Promise<void> {
    return this.events.privilegedChange({
      eventType: "staff.bootstrap",
      metadata: { actor: "staff.bootstrap", targetStaffId: staff.id, action, revokedSessions },
    });
  }
}
