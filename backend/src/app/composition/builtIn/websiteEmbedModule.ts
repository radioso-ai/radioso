import { createWebsiteEmbedSurfaceExtension } from "../../../modules/agents/public.js";
import { DefaultWebsiteEmbedIntegrationProvider } from "../../../modules/settings/composition.js";
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
