import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { createEnterpriseEmailService } from "../mail/emailService.js";
import { humanContactMigrator } from "./humanContactMigrator.js";
import { createHumanContactRoutes } from "./humanContactRoutes.js";
import { EnterpriseHumanContactService } from "./humanContactService.js";
import { humanContactRequestSkillDefinition } from "../skills/definitions/human_contact.request.js";

export interface HumanContactModuleState {
  service: EnterpriseHumanContactService | null;
}

export const createHumanContactApplicationModule = (
  state: HumanContactModuleState = { service: null },
): ApplicationModule => ({
  id: "radioso-enterprise-human-contact",
  name: "Radioso Enterprise Human Contact",
  register(context) {
    context.registerDatabaseMigrator(humanContactMigrator);
    context.registerSkillDefinition(humanContactRequestSkillDefinition);
    context.registerChatActionProvider((dependencies) => {
      state.service?.stop();
      state.service = new EnterpriseHumanContactService({
        ...dependencies,
        emailService: createEnterpriseEmailService(),
      });
      return state.service;
    });
    context.registerContactHistoryProvider(() => {
      if (state.service) {
        return state.service;
      }
      throw new Error("Enterprise contact service is not initialized");
    });
    context.registerRouteMount({
      path: "/api/v1/ee/contact",
      createRouter(dependencies) {
        if (!state.service) {
          throw new Error("Enterprise contact service is not initialized");
        }
        return createHumanContactRoutes(dependencies, state.service);
      },
    });
  },
  async shutdown() {
    state.service?.stop();
    state.service = null;
  },
});
