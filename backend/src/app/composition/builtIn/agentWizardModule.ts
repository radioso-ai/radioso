import type { ApplicationModule, ApplicationRouteMount } from "../applicationModule.js";
import { createAgentWizardRoutes } from "../../../modules/agentWizard/routes.js";

export const createAgentWizardApplicationModule = (): ApplicationModule => ({
  id: "radioso-agent-wizard",
  name: "Radioso Agent Wizard",
  register(context) {
    // The service itself is composed once in the application dependencies, because Ray's
    // analyze_website probe and propose_agent adapter reach the same wizard these routes do.
    const createRouter: ApplicationRouteMount["createRouter"] = (dependencies) =>
      createAgentWizardRoutes(dependencies, dependencies.agentWizardService);

    context.registerRouteMount({
      path: "/api/v1/agent-wizard",
      createRouter,
    });
  },
});
