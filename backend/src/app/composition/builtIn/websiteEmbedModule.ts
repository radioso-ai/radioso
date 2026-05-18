import { createWebsiteEmbedSurfaceExtension } from "../../../modules/agents/services/websiteEmbedSurfaceExtension.js";
import { DefaultWebsiteEmbedIntegrationProvider } from "../../../modules/settings/domain/websiteEmbedIntegration.js";
import type { ApplicationModule } from "../applicationModule.js";

export interface WebsiteEmbedApplicationModuleOptions {
  widgetOrigin?: string;
}

export const createWebsiteEmbedApplicationModule = (
  options: WebsiteEmbedApplicationModuleOptions = {},
): ApplicationModule => ({
  id: "radioso-website-embed",
  name: "Radioso Website Embed",
  register(context) {
    context.registerAgentSurfaceExtension(createWebsiteEmbedSurfaceExtension());
    context.registerWebsiteEmbedIntegration(
      new DefaultWebsiteEmbedIntegrationProvider({ widgetOrigin: options.widgetOrigin }),
    );
  },
});
