import type { FeatureManifest } from "../featureManifest.js";

export const usageLimitsFeatureManifest: FeatureManifest = {
  id: "enterprise-usage-limits",
  name: "Enterprise Usage Limits",
  edition: "enterprise",
  backendModuleId: "radioso-enterprise-usage-limits",
  apiNamespaces: ["/api/v1/ee/usage-limits"],
  docs: ["ee/readme.md"],
};
