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
      relativePath: "lib/agent-creation-contributions.tsx",
      packageName: "@radioso/enterprise-agent-wizard-frontend",
      exportPath: "wizard-dialog",
      exports: [
        "WizardDialog",
        "clearAgentCreationHandoff",
        "readAgentCreationHandoff",
      ],
    },
  ],
  docs: ["ee/readme.md"],
};
