import type { FeatureManifest } from "../featureManifest.js";

export const websiteCrawlerFeatureManifest: FeatureManifest = {
  id: "enterprise-website-crawler",
  name: "Enterprise Website Crawler",
  edition: "enterprise",
  backendModuleId: "radioso-enterprise-website-crawler",
  apiNamespaces: ["/api/v1/ee/website-crawler"],
  docs: ["ee/readme.md"],
};
