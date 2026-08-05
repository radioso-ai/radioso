import { AccountMembershipRepository } from "../../../db/repositories/accountMembershipRepository.js";
import { ConversationRepository } from "../../../db/repositories/conversationRepository.js";
import { DocumentRepository } from "../../../db/repositories/documentRepository.js";
import { WorkspaceRepository } from "../../../db/repositories/workspaceRepository.js";
import { AccountAccessService, AccountInvitationService } from "../../../modules/account/public.js";
import { AccessGrantService, DefaultOriginMatcher } from "../../../modules/accessGrants/public.js";
import { AuditService } from "../../../modules/audit/composition.js";
import type { AuditPort } from "../../../modules/audit/contracts/index.js";
import { AuthService } from "../../../modules/auth/services/authService.js";
import { PostgresOrganizationProvisioner } from "../../../modules/auth/infra/postgresOrganizationProvisioner.js";
import { EmailVerificationService } from "../../../modules/auth/services/emailVerificationService.js";
import { PasswordResetService } from "../../../modules/auth/services/passwordResetService.js";
import { WorkspaceSessionService } from "../../../modules/auth/services/workspaceSessionService.js";
import {
  type WorkspaceProviderCredentialsRepositoryPort,
} from "../../../db/repositories/workspaceProviderCredentialsRepository.js";
import {
  WorkspaceProviderCredentialsService,
} from "../../../modules/security/credentials/services/workspaceProviderCredentialsService.js";
import { WorkspaceService, WorkspaceSummaryService } from "../../../modules/workspace/public.js";
import type { OrganizationCreationGuard } from "../../../shared/domain/organizationCreationGuard.js";
import { Database } from "../../../shared/infra/database.js";
import { type AppLogger } from "../../../shared/observability/logger.js";
import type { Env } from "../../config/env.js";
import { buildInfrastructure, buildRepositories } from "./infra.js";


export const buildAccessServices = (input: {
  auditService: AuditService;
  env: Pick<Env, "WORKSPACE_TOKEN_SECRET">;
  repositories: ReturnType<typeof buildRepositories>;
}) => {
  const { auditService, env, repositories } = input;
  const accessGrantService = new AccessGrantService({
    repository: repositories.accessGrantRepository,
    originMatcher: new DefaultOriginMatcher(),
    workspaceTokenSecret: env.WORKSPACE_TOKEN_SECRET,
    auditService,
  });
  const accountAccessService = new AccountAccessService(
    repositories.accountMembershipRepository,
    auditService,
    repositories.workspaceGrantRepository,
    repositories.workspaceRepository,
  );
  const accountInvitationService = new AccountInvitationService(
    repositories.accountInvitationRepository,
    repositories.userRepository,
    accountAccessService,
    auditService,
  );

  return {
    accessGrantService,
    accountAccessService,
    accountInvitationService,
  };
};

export const buildWorkspaceProviderCredentialsService = (input: {
  auditService: AuditPort;
  env: Pick<Env, "CONNECTOR_ENCRYPTION_KEY">;
  logger: Pick<AppLogger, "warn">;
  repositories: { workspaceProviderCredentialsRepository: WorkspaceProviderCredentialsRepositoryPort };
}): WorkspaceProviderCredentialsService => {
  const service = new WorkspaceProviderCredentialsService(
    input.repositories.workspaceProviderCredentialsRepository,
    input.auditService,
    { key: input.env.CONNECTOR_ENCRYPTION_KEY },
    input.logger,
  );
  service.onDecryptError((error, provider) => {
    input.logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        provider,
        remediation:
          "Stored credential ciphertext could not be decrypted. Re-enter the API key for this provider after rotating CONNECTOR_ENCRYPTION_KEY.",
      },
      "Workspace provider credential decrypt failed",
    );
  });
  if (!service.isEncryptionConfigured()) {
    input.logger.warn(
      {
        remediation: "Set CONNECTOR_ENCRYPTION_KEY before saving workspace provider API keys.",
      },
      "Workspace provider credential encryption is not configured; credential writes will be rejected until this is fixed",
    );
  }
  return service;
};

export const buildWorkspaceServices = (input: {
  accountMembershipRepository: AccountMembershipRepository;
  auditService: AuditService;
  conversationRepository: ConversationRepository;
  documentRepository: DocumentRepository;
  env: Env;
  workspaceRepository: WorkspaceRepository;
}) => {
  const workspaceService = new WorkspaceService(
    input.workspaceRepository,
    input.auditService,
    input.accountMembershipRepository,
  );
  return {
    workspaceService,
    workspaceSessionService: new WorkspaceSessionService(workspaceService),
    workspaceSummaryService: new WorkspaceSummaryService(input.documentRepository, input.conversationRepository, {
      websiteCrawlerEnabled: input.env.WEBSITE_CRAWLER_ENABLED,
    }),
  };
};

export const buildAuthService = (input: {
  access: ReturnType<typeof buildAccessServices>;
  auditService: AuditService;
  database: Database;
  env: Env;
  organizationCreationGuard: OrganizationCreationGuard;
  onAccountCreated?: (input: { accountId: string }) => Promise<void>;
  repositories: ReturnType<typeof buildRepositories>;
  workspaceService: WorkspaceService;
}): AuthService =>
  new AuthService({
    env: input.env,
    accountRepository: input.repositories.accountRepository,
    userRepository: input.repositories.userRepository,
    sessionRepository: input.repositories.sessionRepository,
    workspaceTokenRepository: input.repositories.workspaceTokenRepository,
    workspaceService: input.workspaceService,
    accountAccessService: input.access.accountAccessService,
    accountInvitationService: input.access.accountInvitationService,
    onAccountCreated: input.onAccountCreated,
    organizationCreationGuard: input.organizationCreationGuard,
    organizationProvisioner: new PostgresOrganizationProvisioner(input.database, input.auditService),
    auditService: input.auditService,
  });

export const buildPasswordResetService = (input: {
  access: ReturnType<typeof buildAccessServices>;
  auditService: AuditService;
  env: Env;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  logger: AppLogger;
  repositories: ReturnType<typeof buildRepositories>;
  workspaceService: WorkspaceService;
}): PasswordResetService =>
  new PasswordResetService({
    env: input.env,
    userRepository: input.repositories.userRepository,
    accountRepository: input.repositories.accountRepository,
    accountAccessService: input.access.accountAccessService,
    workspaceService: input.workspaceService,
    sessionRepository: input.repositories.sessionRepository,
    passwordResetTokenRepository: input.repositories.passwordResetTokenRepository,
    mailService: input.infrastructure.mailService,
    auditService: input.auditService,
    logger: input.logger,
  });

export const buildEmailVerificationService = (input: {
  auditService: AuditService;
  env: Env;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  logger: AppLogger;
  repositories: ReturnType<typeof buildRepositories>;
}): EmailVerificationService =>
  new EmailVerificationService({
    env: input.env,
    userRepository: input.repositories.userRepository,
    emailVerificationTokenRepository: input.repositories.emailVerificationTokenRepository,
    mailService: input.infrastructure.mailService,
    auditService: input.auditService,
    logger: input.logger,
  });
