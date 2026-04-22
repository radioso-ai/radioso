import type { RadiosoMcpConfig } from "../config.js";
import { createRadiosoApiAdapter, RadiosoApiError } from "../radiosoApiAdapter.js";

export interface WorkspaceTokenValidationResult {
  apiVersion?: string;
  mcpContextVersion?: string;
  supportedTools?: string[];
  workspaceHint?: string;
  workspaceId?: string;
  workspaceName?: string;
}

export const validateWorkspaceTokenWithFallback = async (
  config: Pick<RadiosoMcpConfig, "baseUrl" | "requestTimeoutMs" | "serverName">,
  radiosoApiToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkspaceTokenValidationResult | void> => {
  const adapter = createRadiosoApiAdapter(
    {
      ...config,
      apiToken: radiosoApiToken,
    },
    fetchImpl,
  );

  try {
    const context = await adapter.getWorkspaceMcpContext();
    return {
      apiVersion: context.apiVersion,
      mcpContextVersion: context.mcpContextVersion,
      supportedTools: context.supportedTools,
      workspaceHint: context.workspaceName,
      workspaceId: context.workspaceId,
      workspaceName: context.workspaceName,
    };
  } catch (error) {
    if (!(error instanceof RadiosoApiError) || error.code !== "unsupported_capability") {
      throw error;
    }

    await adapter.listDocuments({ limit: 1 });
    return undefined;
  }
};
