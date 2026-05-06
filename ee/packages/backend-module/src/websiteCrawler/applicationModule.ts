import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { createWebsiteCrawlerRoutes } from "./routes.js";
import type { WebsiteCrawlerProvider } from "./provider.js";

export interface WebsiteCrawlerApplicationModuleOptions {
  websiteCrawlerProvider?: WebsiteCrawlerProvider;
}

export const createWebsiteCrawlerApplicationModule = (
  options: WebsiteCrawlerApplicationModuleOptions = {},
): ApplicationModule => ({
  id: "radioso-enterprise-website-crawler",
  name: "Radioso Enterprise Website Crawler",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/ee/website-crawler",
      createRouter(dependencies) {
        return createWebsiteCrawlerRoutes(dependencies, {
          provider: options.websiteCrawlerProvider,
        });
      },
    });
  },
});
