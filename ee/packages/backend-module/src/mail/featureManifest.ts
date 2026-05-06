import type { FeatureManifest } from "../featureManifest.js";

export const enterpriseAuthFeatureManifest: FeatureManifest = {
  id: "enterprise-auth",
  name: "Enterprise Auth",
  edition: "enterprise",
  backendModuleId: "radioso-enterprise-auth",
  apiNamespaces: ["/api/v1/ee/auth"],
  docs: ["ee/readme.md"],
};
