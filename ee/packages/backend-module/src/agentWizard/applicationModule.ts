import type { ApplicationModule } from "../radiosoModuleTypes.js";
import { createAgentWizardRoutes } from "./agentWizardRoutes.js";
import { AgentWizardService } from "./agentWizardService.js";

export const createAgentWizardApplicationModule = (): ApplicationModule => ({
  id: "radioso-enterprise-agent-wizard",
  name: "Radioso Enterprise Agent Wizard",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/ee/agent-wizard",
      createRouter(dependencies) {
        if (!dependencies.chatTextGenerationClient) {
          throw new Error("Agent wizard requires chatTextGenerationClient");
        }
        if (!dependencies.agentService) {
          throw new Error("Agent wizard requires agentService");
        }
        if (!dependencies.documentStorage) {
          throw new Error("Agent wizard requires documentStorage");
        }
        if (!dependencies.websiteCrawlJobService) {
          throw new Error("Agent wizard requires websiteCrawlJobService");
        }
        if (!dependencies.crawlerProvider) {
          throw new Error("Agent wizard requires crawlerProvider");
        }
        if (!dependencies.assertPublicWebsiteUrl) {
          throw new Error("Agent wizard requires assertPublicWebsiteUrl");
        }
        if (!dependencies.websiteCrawlerLimits) {
          throw new Error("Agent wizard requires websiteCrawlerLimits");
        }

        const service = new AgentWizardService({
          textGenerationClient: dependencies.chatTextGenerationClient,
          agentService: dependencies.agentService,
          documentStorage: dependencies.documentStorage,
          websiteCrawlJobService: dependencies.websiteCrawlJobService,
          crawlerProvider: dependencies.crawlerProvider,
          assertPublicWebsiteUrl: dependencies.assertPublicWebsiteUrl,
          crawlerLimits: dependencies.websiteCrawlerLimits,
          auditService: dependencies.auditService,
        });

        return createAgentWizardRoutes(dependencies, service);
      },
    });
  },
});
