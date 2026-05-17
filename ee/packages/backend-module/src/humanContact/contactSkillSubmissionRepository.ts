import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { createSkillSubmissionRepository } from "../skillSubmissions/skillSubmissionRepositoryFactory.js";
import type {
  SkillSubmissionRepository,
  SkillSubmissionRepositoryOptions,
} from "../skillSubmissions/skillSubmissionRepository.js";
import type { AuditService } from "./humanContactTypes.js";
import { HUMAN_CONTACT_SKILL_NAME } from "./humanContactTypes.js";
import { humanContactRequestSkillDefinition } from "./skill/definition.js";

export interface HumanContactSkillSubmissionRepositoryOptions extends SkillSubmissionRepositoryOptions {
  auditService?: AuditService;
}

const humanContactSkillSubmissionDefinitions = [
  humanContactRequestSkillDefinition,
];

export const createHumanContactSkillSubmissionRepository = (
  database: UsageLimitDatabasePort,
  options: HumanContactSkillSubmissionRepositoryOptions = {},
): SkillSubmissionRepository => {
  const { auditService, onInvalidClaim, ...repositoryOptions } = options;
  return createSkillSubmissionRepository(database, humanContactSkillSubmissionDefinitions, {
    ...repositoryOptions,
    async onInvalidClaim(input) {
      let hookError: unknown;
      try {
        await onInvalidClaim?.(input);
      } catch (error) {
        hookError = error;
      }
      if (!auditService || input.row.skill_name !== HUMAN_CONTACT_SKILL_NAME) {
        if (hookError) {
          throw hookError;
        }
        return;
      }
      try {
        await auditService.record({
          accountId: input.row.account_id,
          workspaceId: input.row.workspace_id,
          eventType: "human_contact.delivery_failed",
          eventStatus: "failure",
          metadata: {
            requestId: input.row.id,
            conversationId: input.row.conversation_id,
            skillName: input.row.skill_name,
            failureKind: "stored_field_validation",
            attempts: input.row.attempts + 1,
            reason: input.reason,
          },
        });
      } catch (error) {
        hookError ??= error;
      }
      if (hookError) {
        throw hookError;
      }
    },
  });
};
