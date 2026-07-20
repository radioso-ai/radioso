import type { UserRepositoryPort } from "../../src/db/repositories/userRepository.js";
import type {
  OrganizationCoreProvisioner,
  OrganizationCoreProvisioningRequest,
  OrganizationCoreProvisioningResult,
} from "../../src/shared/domain/organizationCreationGuard.js";
import { conflict } from "../../src/shared/domain/errors.js";
import type { AccountAccessService } from "../../src/modules/account/public.js";
import type { AccountRepositoryPort } from "../../src/modules/auth/services/authService.js";
import type { WorkspaceService } from "../../src/modules/workspace/public.js";

/** Test-only in-memory equivalent of the production transactional provisioner. */
export class InMemoryOrganizationProvisioner implements OrganizationCoreProvisioner {
  constructor(
    private readonly accountRepository: AccountRepositoryPort,
    private readonly userRepository: UserRepositoryPort,
    private readonly accountAccessService: Pick<AccountAccessService, "ensureMembership">,
    private readonly workspaceService: Pick<WorkspaceService, "createDefault">,
  ) {}

  async provision(input: OrganizationCoreProvisioningRequest): Promise<OrganizationCoreProvisioningResult> {
    if (input.intent === "new_user" && await this.userRepository.findByEmail(input.email)) {
      throw conflict("Account already exists");
    }

    let accountId: string | null = null;
    let createdUserId: string | null = null;
    try {
      const account = await this.accountRepository.create({
        name: input.organizationName,
        email: input.email,
        passwordHash: input.passwordHash,
      });
      accountId = account.id;
      const userId = input.intent === "new_user"
        ? (await this.userRepository.create({
            id: account.id,
            email: input.email,
            passwordHash: input.passwordHash,
            emailVerifiedAt: input.emailVerifiedAt,
          })).id
        : input.userId;
      if (input.intent === "new_user") createdUserId = userId;
      await this.accountAccessService.ensureMembership({ accountId: account.id, userId, role: "owner" });
      const workspace = await this.workspaceService.createDefault(account.id);

      return {
        account: { id: account.id, name: account.name },
        userId,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          publicRouteKey: workspace.publicRouteKey,
        },
      };
    } catch (error) {
      if (accountId) await this.accountRepository.deleteById(accountId);
      if (createdUserId) await this.userRepository.deleteById(createdUserId);
      throw error;
    }
  }
}
