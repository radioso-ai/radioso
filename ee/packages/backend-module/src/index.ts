import type { ApplicationModule } from "./radiosoModuleTypes.js";

import { HostedWebsiteEmbedIntegrationProvider } from "./websiteEmbedIntegration.js";

export const applicationModule: ApplicationModule = {
  id: "radioso-enterprise-backend",
  name: "Radioso Enterprise Backend",
  register(context) {
    context.registerWebsiteEmbedIntegration(new HostedWebsiteEmbedIntegrationProvider({
      widgetOrigin: process.env.RADIOSO_ENTERPRISE_WIDGET_ORIGIN,
      scriptPath: process.env.RADIOSO_ENTERPRISE_WIDGET_SCRIPT_PATH,
    }));
  },
};

export default applicationModule;
