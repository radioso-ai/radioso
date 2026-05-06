import type { FeatureManifest } from "../featureManifest.js";

export const humanContactFeatureManifest: FeatureManifest = {
  id: "enterprise-human-contact",
  name: "Enterprise Human Contact",
  edition: "enterprise",
  backendModuleId: "radioso-enterprise-human-contact",
  apiNamespaces: ["/api/v1/ee/contact"],
  docs: ["ee/readme.md"],
};
