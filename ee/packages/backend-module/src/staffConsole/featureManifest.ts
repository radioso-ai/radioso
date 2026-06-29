import type { FeatureManifest } from "../featureManifest.js";

export const staffConsoleFeatureManifest: FeatureManifest = {
  id: "enterprise-operator-console",
  name: "Enterprise Operator Console",
  edition: "enterprise",
  backendModuleId: "radioso-enterprise-operator-console",
  apiNamespaces: ["/api/v1/ee/operator-console"],
  docs: ["ee/readme.md"],
};
