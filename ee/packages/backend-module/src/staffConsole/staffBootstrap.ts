import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { HttpError } from "../shared/httpError.js";
import { hashStaffPassword } from "./staffCrypto.js";
import type { StaffUserRepository } from "./staffRepository.js";
import type { StaffUser } from "./staffTypes.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

export class StaffBootstrapService {
  constructor(
    private readonly users: StaffUserRepository,
    private readonly auditService: RouteDependencies["auditService"],
  ) {}

  async bootstrapOwner(input: { email: string; name: string; password: string }): Promise<StaffUser> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.users.findByEmail(email);
    const passwordHash = await hashStaffPassword(input.password);
    const owner = existing
      ? await this.resetExistingOwner(existing, passwordHash)
      : await this.users.create({
        email,
        name: input.name.trim(),
        passwordHash,
        role: "owner",
        status: "active",
      });

    await this.auditService.record({
      accountId: null,
      workspaceId: null,
      eventType: "staff.bootstrap",
      eventStatus: "success",
      metadata: {
        actor: "staff.bootstrap",
        targetStaffId: owner.id,
        action: existing ? "reset_owner" : "create_owner",
      },
    });

    return owner;
  }

  private async resetExistingOwner(existing: StaffUser, passwordHash: string): Promise<StaffUser> {
    if (existing.role !== "owner") {
      throw new HttpError(409, "staff_bootstrap_conflict", "Bootstrap can only reset an existing owner.");
    }
    const updated = await this.users.updatePassword(existing.id, passwordHash);
    if (!updated) {
      throw new HttpError(404, "not_found", "Staff owner not found.");
    }
    return updated;
  }
}
