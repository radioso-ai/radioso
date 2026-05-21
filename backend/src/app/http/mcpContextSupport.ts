import { z } from "zod";

import type {
  AccountAccessService,
  AccountPermission,
  AuthenticatedPrincipal,
} from "../../modules/account/services/accountAccessService.js";

export const supportedMcpTools = [
  "answer_grounded",
  "create_document",
  "delete_document",
  "describe_capabilities",
  "get_document",
  "get_retrieval_settings",
  "list_documents",
  "reprocess_document",
  "search_documents",
  "update_document",
  "update_retrieval_settings",
] as const;

export const MCP_CONTEXT_VERSION = "2026-05-06";

export const workspaceMcpContextSchema = z.object({
  apiVersion: z.literal("0.1.0"),
  mcpContextVersion: z.literal(MCP_CONTEXT_VERSION),
  supportedTools: z.array(z.enum(supportedMcpTools)),
  workspaceId: z.string().uuid(),
  workspaceName: z.string().min(1),
});

// Token-management permissions are intentionally omitted; no MCP tool exposes token management.
const mcpToolPermissionGroups: Array<{
  permission: AccountPermission;
  tools: Array<(typeof supportedMcpTools)[number]>;
}> = [
  {
    permission: "workspace.retrieval.query",
    tools: ["answer_grounded"],
  },
  {
    permission: "workspace.documents.read",
    tools: ["get_document", "list_documents", "search_documents"],
  },
  {
    permission: "workspace.settings.read",
    tools: ["get_retrieval_settings"],
  },
  {
    permission: "workspace.documents.manage",
    tools: ["create_document", "delete_document", "reprocess_document", "update_document"],
  },
  {
    permission: "workspace.settings.manage",
    tools: ["update_retrieval_settings"],
  },
];

export const resolveSupportedMcpToolsForPrincipal = async (
  accountAccessService: AccountAccessService,
  input: {
    accountId: string;
    principal?: AuthenticatedPrincipal | null;
    userId?: string | null;
    workspaceId: string;
  },
): Promise<Array<(typeof supportedMcpTools)[number]>> => {
  const allowed = new Set<(typeof supportedMcpTools)[number]>(["describe_capabilities"]);
  const permissionResults = await Promise.all(
    mcpToolPermissionGroups.map(async (group) => ({
      group,
      granted: await accountAccessService.hasPermission({
        accountId: input.accountId,
        principal: input.principal,
        userId: input.userId,
        workspaceId: input.workspaceId,
        permission: group.permission,
      }),
    })),
  );

  for (const result of permissionResults) {
    if (result.granted) {
      for (const tool of result.group.tools) {
        allowed.add(tool);
      }
    }
  }

  // A describe-only response is valid: clients can introspect the empty effective tool surface.
  return supportedMcpTools.filter((tool) => allowed.has(tool));
};
