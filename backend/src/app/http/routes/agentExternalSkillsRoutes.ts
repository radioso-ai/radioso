import { Router, type Request, type Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest } from "../../../shared/domain/errors.js";
import {
  mcpConnectionInputSchema,
  mcpConnectionUpdateSchema,
  skillDefinitionInputSchema,
  skillDefinitionUpdateSchema,
} from "../../../modules/externalSkills/domain.js";

const uuidSchema = z.string().uuid();
const parseId = (value: unknown, field: string): string => {
  const result = uuidSchema.safeParse(value);
  if (!result.success) {
    throw badRequest(`Invalid ${field}`);
  }
  return result.data;
};

/**
 * Per-agent authoring routes for MCP connections + external skill definitions.
 * Mounted at /api/v1/agents alongside the agent routes. Reads require
 * workspace.agents.read; writes require workspace.agents.manage. The agent is
 * resolved through agentService so callers can only touch agents in their
 * workspace. Credentials are write-only (never returned).
 */
export const createAgentExternalSkillsRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentRead = requireWorkspacePermission(dependencies, "workspace.agents.read");
  const agentManage = requireWorkspacePermission(dependencies, "workspace.agents.manage");

  // Verifies the agent exists in the caller's workspace (throws notFound otherwise).
  const resolveAgentId = async (req: Request, res: Response): Promise<string> => {
    const { workspaceId } = res.locals as { workspaceId: string };
    const agentId = parseId(req.params.agentId, "agentId");
    await dependencies.agentService.get(workspaceId, agentId);
    return agentId;
  };

  // --- MCP connections ---

  router.get("/:agentId/mcp-connections", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const agentId = await resolveAgentId(req, res);
      res.status(200).json({ connections: await dependencies.mcpConnectionService.list(agentId) });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:agentId/mcp-connections",
    workspaceSession,
    agentManage,
    validateBody(mcpConnectionInputSchema),
    async (req, res, next) => {
      try {
        const agentId = await resolveAgentId(req, res);
        res.status(201).json(await dependencies.mcpConnectionService.create(agentId, req.body));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post("/:agentId/mcp-connections/:connectionId/discover", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const agentId = await resolveAgentId(req, res);
      const tools = await dependencies.mcpConnectionService.discoverTools(agentId, parseId(req.params.connectionId, "connectionId"));
      res.status(200).json({ tools });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:agentId/mcp-connections/:connectionId", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const agentId = await resolveAgentId(req, res);
      res.status(200).json(await dependencies.mcpConnectionService.get(agentId, parseId(req.params.connectionId, "connectionId")));
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    "/:agentId/mcp-connections/:connectionId",
    workspaceSession,
    agentManage,
    validateBody(mcpConnectionUpdateSchema),
    async (req, res, next) => {
      try {
        const agentId = await resolveAgentId(req, res);
        res.status(200).json(
          await dependencies.mcpConnectionService.update(agentId, parseId(req.params.connectionId, "connectionId"), req.body),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/:agentId/mcp-connections/:connectionId", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const agentId = await resolveAgentId(req, res);
      await dependencies.mcpConnectionService.remove(agentId, parseId(req.params.connectionId, "connectionId"));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // --- External skill definitions ---

  router.get("/:agentId/external-skills", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const agentId = await resolveAgentId(req, res);
      res.status(200).json({ skills: await dependencies.externalSkillDefinitionService.list(agentId) });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:agentId/external-skills",
    workspaceSession,
    agentManage,
    validateBody(skillDefinitionInputSchema),
    async (req, res, next) => {
      try {
        const agentId = await resolveAgentId(req, res);
        res.status(201).json(await dependencies.externalSkillDefinitionService.create(agentId, req.body));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/:agentId/external-skills/:skillId", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const agentId = await resolveAgentId(req, res);
      res.status(200).json(await dependencies.externalSkillDefinitionService.get(agentId, parseId(req.params.skillId, "skillId")));
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    "/:agentId/external-skills/:skillId",
    workspaceSession,
    agentManage,
    validateBody(skillDefinitionUpdateSchema),
    async (req, res, next) => {
      try {
        const agentId = await resolveAgentId(req, res);
        res.status(200).json(
          await dependencies.externalSkillDefinitionService.update(agentId, parseId(req.params.skillId, "skillId"), req.body),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/:agentId/external-skills/:skillId", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const agentId = await resolveAgentId(req, res);
      await dependencies.externalSkillDefinitionService.remove(agentId, parseId(req.params.skillId, "skillId"));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
