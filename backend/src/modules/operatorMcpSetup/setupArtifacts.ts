export type OperatorMcpSetupArtifactStatus = "verified" | "unavailable" | "unverified";

export interface OperatorMcpSetupArtifact {
  id: string;
  displayName: string;
  clientVersion: string | null;
  status: OperatorMcpSetupArtifactStatus;
  description: string;
  setupInstructions: readonly string[];
  command: string | null;
  configuration: string | null;
  handoffUrl: string | null;
  permittedLaunchTarget: string;
  expectedClientId: string | null;
  redirectMechanism: string;
  failureRecovery: string;
}

export interface OperatorMcpSetupResponse {
  availability: "available" | "disabled" | "misconfigured" | "unavailable";
  resource: string | null;
  artifacts: readonly OperatorMcpSetupArtifact[];
  checkedAt: string;
  message: string | null;
}

const quickSetupArtifact = (input: {
  id: string;
  displayName: string;
  description: string;
  command?: string;
  configuration?: string;
  permittedLaunchTarget: string;
  redirectMechanism: string;
}): OperatorMcpSetupArtifact => ({
  ...input,
  clientVersion: null,
  status: "unverified",
  setupInstructions: [input.description],
  command: input.command ?? null,
  configuration: input.configuration ?? null,
  handoffUrl: null,
  expectedClientId: null,
  failureRecovery: "Remove this server from the client and add it again.",
});

const setupArtifacts = (resource: string): readonly OperatorMcpSetupArtifact[] => [
  quickSetupArtifact({
    id: "codex-cli",
    displayName: "Codex",
    description: "Paste this in your terminal.",
    command: `codex mcp add radioso --url ${resource} && codex mcp login radioso`,
    permittedLaunchTarget: "Codex MCP configuration",
    redirectMechanism: "client-managed OAuth redirect",
  }),
  quickSetupArtifact({
    id: "claude-code",
    displayName: "Claude",
    description: "Paste this in your terminal, then run /mcp in Claude to sign in.",
    command: `claude mcp add --transport http radioso ${resource}`,
    permittedLaunchTarget: "Claude MCP configuration",
    redirectMechanism: "client-managed OAuth redirect",
  }),
  quickSetupArtifact({
    id: "cursor",
    displayName: "Cursor",
    description: "Paste this into .cursor/mcp.json, then sign in when Cursor asks.",
    configuration: JSON.stringify({ mcpServers: { radioso: { type: "http", url: resource } } }, null, 2),
    permittedLaunchTarget: "Cursor MCP configuration",
    redirectMechanism: "client-managed OAuth redirect",
  }),
  quickSetupArtifact({
    id: "generic",
    displayName: "Other",
    description: "Paste this into your client's remote HTTP MCP setup.",
    configuration: JSON.stringify({ transport: "http", url: resource }, null, 2),
    permittedLaunchTarget: "client-managed remote HTTP setup",
    redirectMechanism: "client-declared exact redirect URI",
  }),
];

export const buildOperatorMcpSetup = (input: {
  enabled: boolean;
  resource: string | undefined;
  ready: boolean;
  now: Date;
}): OperatorMcpSetupResponse => {
  if (!input.enabled) {
    return { availability: "disabled", resource: null, artifacts: [], checkedAt: input.now.toISOString(), message: "Operator MCP access is disabled." };
  }
  if (!input.resource) {
    return { availability: "misconfigured", resource: null, artifacts: [], checkedAt: input.now.toISOString(), message: "Operator MCP access is not configured." };
  }
  if (!input.ready) {
    return { availability: "unavailable", resource: null, artifacts: [], checkedAt: input.now.toISOString(), message: "Operator MCP access is not ready. Check the deployment credential epoch and internal secret configuration." };
  }
  return {
    availability: "available",
    resource: input.resource,
    artifacts: setupArtifacts(input.resource),
    checkedAt: input.now.toISOString(),
    message: null,
  };
};
