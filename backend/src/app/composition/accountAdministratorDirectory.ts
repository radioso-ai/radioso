import type { AccountMembershipRepository } from "../../db/repositories/accountMembershipRepository.js";
import type {
  ApplicationAccountAdministratorContact,
  ApplicationAccountAdministratorDirectoryPort,
} from "./applicationModule.js";

const ADMINISTRATOR_ROLES = new Set(["owner", "admin"]);

/**
 * The default `ApplicationAccountAdministratorDirectoryPort`: active owner + admin members of
 * an account, never disabled. Deliberately not the single-recipient
 * `WorkspaceOwnerContactRecipientResolver` other OSS notices use — a usage alert is
 * account-wide and every administrator should see it, not just the account owner.
 */
export const createAccountAdministratorDirectory = (
  repository: Pick<AccountMembershipRepository, "listActiveByAccount">,
): ApplicationAccountAdministratorDirectoryPort => ({
  async list(accountId: string): Promise<ApplicationAccountAdministratorContact[]> {
    const memberships = await repository.listActiveByAccount(accountId);
    return memberships
      .filter((membership) => ADMINISTRATOR_ROLES.has(membership.role) && !membership.disabledAt)
      .map((membership) => ({ email: membership.email, displayName: membership.displayName }));
  },
});
