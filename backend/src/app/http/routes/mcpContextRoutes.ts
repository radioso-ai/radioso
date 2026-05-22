import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { forbidden } from "../../../shared/domain/errors.js";
import { requireApiToken, type ApiTokenDependencies } from "../middleware/requireApiToken.js";
import type { AuthenticatedPrincipal } from "../../../modules/account/services/accountAccessService.js";
import { MCP_CONTEXT_VERSION, resolveSupportedMcpToolsForPrincipal } from "../mcpContextSupport.js";

type McpContextRouteDependencies = ApiTokenDependencies &
  Pick<AppDependencies, "accountAccessService" | "workspaceRepository">;

export const createMcpContextRoutes = (dependencies: McpContextRouteDependencies): Router => {
  const router = Router();

  router.get("/context", requireApiToken(dependencies), async (_req, res, next) => {
    try {
      const { accountId, authPrincipal, workspaceId } = res.locals as {
        accountId: string;
        authPrincipal?: AuthenticatedPrincipal;
        workspaceId: string;
      };
      const workspace = await dependencies.workspaceRepository.findById(workspaceId);
      if (!workspace) {
        throw forbidden("Workspace token no longer resolves to an active workspace.");
      }
      const scopedTools = await resolveSupportedMcpToolsForPrincipal(dependencies.accountAccessService, {
        accountId,
        principal: authPrincipal,
        workspaceId,
      });

      res.status(200).json({
        apiVersion: "0.1.0",
        mcpContextVersion: MCP_CONTEXT_VERSION,
        supportedTools: scopedTools,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
