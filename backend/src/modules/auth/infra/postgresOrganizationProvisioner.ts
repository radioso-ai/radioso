import type { Transaction } from "kysely";

import { AccountMembershipRepository } from "../../../db/repositories/accountMembershipRepository.js";
import { AccountRepository } from "../../../db/repositories/accountRepository.js";
import { UserRepository } from "../../../db/repositories/userRepository.js";
import { WorkspaceRepository } from "../../../db/repositories/workspaceRepository.js";
import type {
  OrganizationCoreProvisioner,
  OrganizationCoreProvisioningRequest,
  OrganizationCoreProvisioningResult,
} from "../../../shared/domain/organizationCreationGuard.js";
import { conflict } from "../../../shared/domain/errors.js";
import type { Database } from "../../../shared/infra/database.js";
import type { DB } from "../../../shared/infra/kysely/schema.js";
import type { AuditService } from "../../audit/contracts/index.js";
import { AccountAccessService } from "../../account/public.js";
import { WorkspaceService } from "../../workspace/public.js";

export interface OrganizationCoreTransactionRunner {
  run<T>(work: (transaction: Transaction<DB>) => Promise<T>): Promise<T>;
}

export class PostgresOrganizationProvisioner implements OrganizationCoreProvisioner {
  private readonly transactionRunner: OrganizationCoreTransactionRunner;

  constructor(
    database: Pick<Database, "kysely">,
    private readonly auditService: AuditService,
    transactionRunner?: OrganizationCoreTransactionRunner,
  ) {
    this.transactionRunner = transactionRunner ?? {
      run: (work) => database.kysely.transaction().execute(work),
    };
  }

  async provision(input: OrganizationCoreProvisioningRequest): Promise<OrganizationCoreProvisioningResult> {
    return this.transactionRunner.run(async (transaction) => {
      const accountRepository = new AccountRepository(transaction);
      const userRepository = new UserRepository(transaction);
      const membershipRepository = new AccountMembershipRepository(transaction);
      const accountAccessService = new AccountAccessService(membershipRepository, this.auditService);
      const workspaceService = new WorkspaceService(new WorkspaceRepository(transaction), this.auditService);

      if (input.intent === "new_user" && await userRepository.findByEmail(input.email)) {
        throw conflict("Account already exists");
      }

      const account = await accountRepository.create({
        name: input.organizationName,
        email: input.email,
        passwordHash: input.passwordHash,
      });
      const userId = input.intent === "new_user"
        ? (await userRepository.create({
            id: account.id,
            email: input.email,
            passwordHash: input.passwordHash,
            emailVerifiedAt: input.emailVerifiedAt,
          })).id
        : input.userId;

      await accountAccessService.ensureMembership({ accountId: account.id, userId, role: "owner" });
      const workspace = await workspaceService.createDefault(account.id);

      return {
        account: { id: account.id, name: account.name },
        userId,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          publicRouteKey: workspace.publicRouteKey,
        },
      };
    });
  }
}
