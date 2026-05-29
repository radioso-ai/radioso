import type { ApplicationModule, ApplicationRouteMount } from "../applicationModule.js";
import { createAgentWizardRoutes } from "../../../modules/agentWizard/routes.js";
import { AgentWizardService } from "../../../modules/agentWizard/service.js";

export const createAgentWizardApplicationModule = (): ApplicationModule => ({
  id: "radioso-agent-wizard",
  name: "Radioso Agent Wizard",
  register(context) {
    const createRouter: ApplicationRouteMount["createRouter"] = (dependencies) => {
      const service = new AgentWizardService({
        // The wizard port only needs generated text; adapt the inference
        // pipeline result object to its narrow string contract.
        textGenerationClient: {
          complete: async ({ signal: _signal, ...input }) =>
            (await dependencies.chatInferencePipeline.complete(input)).text,
        },
        agentService: dependencies.agentService,
        documentStorage: dependencies.documentStorage,
        websiteCrawlJobService: dependencies.websiteCrawlJobService,
        crawlerProvider: dependencies.crawlerProvider,
        assertPublicWebsiteUrl: dependencies.assertPublicWebsiteUrl,
        crawlerLimits: dependencies.websiteCrawlerLimits,
        auditService: dependencies.auditService,
      });

      return createAgentWizardRoutes(dependencies, service);
    };

    context.registerRouteMount({
      path: "/api/v1/agent-wizard",
      createRouter,
    });
  },
});
