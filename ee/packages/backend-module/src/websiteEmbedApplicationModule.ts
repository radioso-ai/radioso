import type { ApplicationModule } from "./radiosoModuleTypes.js";

import { HostedWebsiteEmbedIntegrationProvider } from "./websiteEmbedIntegration.js";

export const createWebsiteEmbedApplicationModule = (): ApplicationModule => ({
  id: "radioso-enterprise-website-embed",
  name: "Radioso Enterprise Website Embed",
  register(context) {
    context.registerWebsiteEmbedIntegration(new HostedWebsiteEmbedIntegrationProvider({
      widgetOrigin: process.env.RADIOSO_ENTERPRISE_WIDGET_ORIGIN,
      scriptPath: process.env.RADIOSO_ENTERPRISE_WIDGET_SCRIPT_PATH,
    }));
  },
});
