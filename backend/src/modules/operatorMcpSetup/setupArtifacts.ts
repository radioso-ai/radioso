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

const unavailableArtifact = (input: {
  id: string;
  displayName: string;
  clientVersion: string | null;
  permittedLaunchTarget: string;
  redirectMechanism: string;
}): OperatorMcpSetupArtifact => ({
  ...input,
  status: "unavailable",
  description: "This exact client build has not completed Radioso's discovery, callback, list, call, refresh, and revoke verification gate.",
  setupInstructions: [],
  command: null,
  configuration: null,
  handoffUrl: null,
  expectedClientId: null,
  failureRecovery: "Use the generic setup only if you can verify your client's remote HTTP OAuth behavior, or wait for a verified build artifact.",
});

const genericArtifact = (resource: string): OperatorMcpSetupArtifact => ({
  id: "generic",
  displayName: "Another MCP client",
  clientVersion: null,
  status: "unverified",
  description: "Configure a remote HTTP MCP server that supports OAuth discovery and explicit resource indicators.",
  setupInstructions: [
    "Add a remote HTTP MCP server in your client.",
    "Enter the canonical operator MCP URL shown below.",
    "Complete browser consent and approve only the scopes you need.",
  ],
  command: null,
  configuration: JSON.stringify({ transport: "http", url: resource }, null, 2),
  handoffUrl: null,
  permittedLaunchTarget: "client-managed remote HTTP setup",
  expectedClientId: null,
  redirectMechanism: "client-declared exact redirect URI",
  failureRecovery: "Remove the connection in your client, revoke the grant in Radioso, then retry with a compatible OAuth MCP client.",
});

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
    artifacts: [
      unavailableArtifact({ id: "codex-cli", displayName: "Codex CLI", clientVersion: "0.149.0", permittedLaunchTarget: "Codex CLI MCP configuration", redirectMechanism: "client-declared loopback redirect" }),
      unavailableArtifact({ id: "claude-code", displayName: "Claude Code", clientVersion: "2.1.149", permittedLaunchTarget: "Claude Code MCP configuration", redirectMechanism: "client-declared loopback redirect" }),
      unavailableArtifact({ id: "chatgpt-developer-mode", displayName: "ChatGPT custom app (developer mode)", clientVersion: null, permittedLaunchTarget: "ChatGPT developer-mode custom app", redirectMechanism: "hosted HTTPS redirect" }),
      genericArtifact(input.resource),
    ],
    checkedAt: input.now.toISOString(),
    message: "Named integrations remain unavailable until their exact builds pass the compatibility evidence gate.",
  };
};
