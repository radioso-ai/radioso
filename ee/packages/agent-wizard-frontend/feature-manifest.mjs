export const featureManifest = {
  id: "enterprise-agent-wizard-frontend",
  name: "Enterprise Agent Wizard Frontend",
  edition: "enterprise",
  frontendAgentCreationActions: [
    {
      id: "website",
      label: "Create from website",
      icon: "globe",
      kind: "wizard-dialog",
    },
  ],
  frontendComponents: [
    {
      relativePath: "lib/enterprise-bridge/agent-wizard-dialog.tsx",
      packageName: "@radioso/enterprise-agent-wizard-frontend",
      exportPath: "wizard-dialog",
      exports: ["WizardDialog"],
    },
  ],
  docs: ["ee/readme.md"],
};
