import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { createEnterpriseEmailService } from "../mail/emailService.js";
import { SkillSubmissionRepository } from "../skillSubmissions/skillSubmissionRepository.js";
import { HumanContactHistoryService } from "./contactHistoryService.js";
import { HumanContactSettingsService } from "./contactSettingsService.js";
import { humanContactMigrator } from "./humanContactMigrator.js";
import { createHumanContactRoutes } from "./humanContactRoutes.js";
import { EnterpriseHumanContactService } from "./humanContactService.js";
import { humanContactRequestSkillDefinition } from "./skill/definition.js";
import type { HumanContactDependencies } from "./humanContactTypes.js";

export interface HumanContactModuleState {
  service: EnterpriseHumanContactService | null;
}

const replaceService = (
  state: HumanContactModuleState,
  dependencies: Omit<HumanContactDependencies, "emailService">,
): EnterpriseHumanContactService => {
  state.service?.stop();
  state.service = new EnterpriseHumanContactService({
    ...dependencies,
    emailService: createEnterpriseEmailService(),
  });
  return state.service;
};

export const createHumanContactApplicationModule = (
  state: HumanContactModuleState = { service: null },
): ApplicationModule => ({
  id: "radioso-enterprise-human-contact",
  name: "Radioso Enterprise Human Contact",
  register(context) {
    context.registerDatabaseMigrator(humanContactMigrator);
    context.registerSkillDefinition?.(humanContactRequestSkillDefinition);
    context.registerChatIntakeProvider?.((dependencies) => {
      return replaceService(state, dependencies).asChatIntakeProvider();
    });
    context.registerContactHistoryProvider((dependencies) => {
      const submissions = new SkillSubmissionRepository(dependencies.database, [humanContactRequestSkillDefinition]);
      const historyService = new HumanContactHistoryService(submissions);
      return {
        listPageByWorkspaceId: (workspaceId, input) => historyService.listPageByWorkspaceId(workspaceId, input),
        getById: (workspaceId, requestId) => historyService.getById(workspaceId, requestId),
      };
    });
    context.registerRouteMount({
      path: "/api/v1/ee/contact",
      createRouter(dependencies) {
        const settingsService = new HumanContactSettingsService({
          database: dependencies.connectorDb,
          auditService: dependencies.auditService,
        });
        return createHumanContactRoutes(dependencies, {
          getSettings: (input) => settingsService.getSettings(input),
          updateSettings: (input) => settingsService.updateSettings(input),
          revealSigningSecret: (input) => settingsService.revealSigningSecret(input),
        });
      },
    });
  },
  async shutdown() {
    state.service?.stop();
    state.service = null;
  },
});
