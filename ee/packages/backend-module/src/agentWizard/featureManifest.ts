import type { FeatureManifest } from "../featureManifest.js";

export const agentWizardFeatureManifest: FeatureManifest = {
  id: "enterprise-agent-wizard",
  name: "Enterprise Agent Wizard",
  edition: "enterprise",
  backendModuleId: "radioso-enterprise-agent-wizard",
  apiNamespaces: ["/api/v1/ee/agent-wizard"],
  docs: ["ee/readme.md"],
};
