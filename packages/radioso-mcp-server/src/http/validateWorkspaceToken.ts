import type { RadiosoMcpConfig } from "../config.js";
import { createRadiosoApiAdapter } from "../radiosoApiAdapter.js";

export interface WorkspaceTokenValidationResult {
  apiVersion?: string;
  mcpContextVersion?: string;
  supportedTools?: string[];
  workspaceHint?: string;
  workspaceId?: string;
  workspaceName?: string;
}

export const validateWorkspaceToken = async (
  config: Pick<RadiosoMcpConfig, "baseUrl" | "requestTimeoutMs" | "serverName">,
  radiosoApiToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkspaceTokenValidationResult> => {
  const adapter = createRadiosoApiAdapter(
    {
      ...config,
      apiToken: radiosoApiToken,
    },
    fetchImpl,
  );

  const context = await adapter.getWorkspaceMcpContext();
  return {
    apiVersion: context.apiVersion,
    mcpContextVersion: context.mcpContextVersion,
    supportedTools: context.supportedTools,
    workspaceHint: context.workspaceName,
    workspaceId: context.workspaceId,
    workspaceName: context.workspaceName,
  };
};
