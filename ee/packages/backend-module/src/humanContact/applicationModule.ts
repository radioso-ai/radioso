import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { skillSubmissionMigrator } from "../skillSubmissions/skillSubmissionMigrator.js";
import { HumanContactHistoryService } from "./contactHistoryService.js";
import { HumanContactSettingsService } from "./contactSettingsService.js";
import { createHumanContactSkillSubmissionRepository } from "./contactSkillSubmissionRepository.js";
import { humanContactMigrator } from "./humanContactMigrator.js";
import { createHumanContactRoutes } from "./humanContactRoutes.js";
import { EnterpriseHumanContactService } from "./humanContactService.js";
import { humanContactRequestSkillDefinition } from "./skill/definition.js";
import { DefinitionBackedIntakePrompts } from "./skill/definitionBackedIntakePrompts.js";
import { HumanContactActionSuggestionProvider } from "./skill/humanContactActionSuggestionProvider.js";
import type { HumanContactDependencies } from "./humanContactTypes.js";

export interface HumanContactModuleState {
  service: EnterpriseHumanContactService | null;
}

const replaceService = (
  state: HumanContactModuleState,
  dependencies: HumanContactDependencies,
): EnterpriseHumanContactService => {
  state.service?.stop();
  state.service = new EnterpriseHumanContactService(dependencies);
  return state.service;
};

export const createHumanContactApplicationModule = (
  state: HumanContactModuleState = { service: null },
): ApplicationModule => ({
  id: "radioso-enterprise-human-contact",
  name: "Radioso Enterprise Human Contact",
  register(context) {
    context.registerDatabaseMigrator(skillSubmissionMigrator);
    context.registerDatabaseMigrator(humanContactMigrator);
    context.registerSkillDefinition?.(humanContactRequestSkillDefinition);
    context.registerChatIntakeProvider?.((dependencies) => {
      return replaceService(state, dependencies).asChatIntakeProvider();
    });
    context.registerChatActionSuggestionProvider?.((dependencies) => {
      const settingsService = new HumanContactSettingsService({
        database: dependencies.database,
        auditService: dependencies.auditService,
      });
      const intakePrompts = new DefinitionBackedIntakePrompts({
        skill: humanContactRequestSkillDefinition,
        chatGateway: dependencies.chatGateway,
      });
      return new HumanContactActionSuggestionProvider({
        settingsService,
        intakePrompts,
      });
    });
    context.registerContactHistoryProvider((dependencies) => {
      const submissions = createHumanContactSkillSubmissionRepository(dependencies.database, {
        logger: dependencies.logger,
      });
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
