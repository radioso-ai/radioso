import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody } from "../middleware/validate.js";
import {
  rejectMachineBundlePublicSurfaceSecrets,
  type MachineAwareRoutePrincipal,
} from "../shared/machinePublicSurfacePolicy.js";
import type { AgentBundle } from "../../../modules/agentBundle/public.js";

const agentParamsSchema = z.object({ agentId: z.string().uuid() });

/**
 * The bundle body is validated for shape here and for meaning by the services the
 * import calls: the agent portion through `validateAgentInput`, directives through
 * `authoredDirectiveInputSchema`, routines through the routine validator, skill
 * config through each capability's own `validateConfig`. Re-declaring those rules
 * at the transport edge would be a second copy that drifts.
 *
 * Every object here passes unknown keys through, deliberately. A stripping schema
 * makes transport the thing that decides which bundle fields survive, which is a
 * contract narrowing nobody sees: `omittedConfigKeys` was silently dropped that way
 * and took the `skill_config_not_portable` report with it. This schema exists to
 * reject a body that is not a bundle, not to define what a bundle contains.
 */
export const agentBundleBodySchema = z.object({
  bundleVersion: z.number().int(),
  portability: z.record(z.string()).optional(),
  agent: z.object({ schemaVersion: z.number().int() }).passthrough(),
  routines: z.array(z.object({
    name: z.string(),
    version: z.number().int(),
    definition: z.unknown(),
  }).passthrough()).default([]),
  contextVariables: z.array(z.object({
    variableName: z.string(),
    source: z.enum(["pushed", "browser", "resolver"]),
    resolverSkillName: z.string().nullable(),
    maxAgeSeconds: z.number().int().nullable(),
    resolverTimeoutMs: z.number().int().nullable(),
    surfacing: z.enum(["always", "on_reference", "operator_only"]),
    enabled: z.boolean(),
  }).passthrough()).default([]),
  agentSkills: z.array(z.object({
    name: z.string(),
    capability: z.string(),
    invocationMode: z.enum(["default_answer", "routine_named", "agent_selectable"]),
    enabled: z.boolean(),
    config: z.record(z.unknown()).default({}),
    omittedConfigKeys: z.array(z.string()).default([]),
    target: z.object({
      kind: z.string().nullable(),
      id: z.unknown().nullable(),
    }).passthrough(),
  }).passthrough()).default([]),
}).passthrough();

export const createAgentBundleRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  // Reading a bundle exposes nothing a workspace reader cannot already read
  // through the agent, skills and context-variable endpoints; writing one creates
  // an agent, so it needs manage.
  const agentRead = requireWorkspacePermission(dependencies, "workspace.agents.read");
  const agentManage = requireWorkspacePermission(dependencies, "workspace.agents.manage");

  router.get("/:agentId/bundle", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
      const { agentId } = agentParamsSchema.parse(req.params);

      const bundle = await dependencies.agentBundleExportService.export(workspaceId, agentId);

      await dependencies.auditService.record({
        accountId: accountId ?? null,
        workspaceId,
        eventType: "agent.bundle.exported",
        eventStatus: "success",
        // Counts, never contents: a bundle holds the agent's instruction and every
        // directive's text.
        metadata: {
          agentId,
          bundleVersion: bundle.bundleVersion,
          routineCount: bundle.routines.length,
          skillCount: bundle.agentSkills.length,
          contextVariableCount: bundle.contextVariables.length,
        },
      });

      res.status(200).json(bundle);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/bundle",
    workspaceSession,
    agentManage,
    validateBody(agentBundleBodySchema),
    async (req, res, next) => {
      try {
        const { workspaceId, accountId, authPrincipal } = res.locals as {
          workspaceId: string;
          accountId?: string;
          authPrincipal?: MachineAwareRoutePrincipal;
        };
        const bundle = req.body as AgentBundle;
        rejectMachineBundlePublicSurfaceSecrets(authPrincipal, bundle.agent);

        let result;
        try {
          result = await dependencies.agentBundleImportService.import(workspaceId, bundle);
        } catch (error) {
          // A failed import is the case an operator actually calls support about,
          // so it needs a trail of its own; the success event alone would leave
          // the attempt invisible.
          await dependencies.auditService.record({
            accountId: accountId ?? null,
            workspaceId,
            eventType: "agent.bundle.imported",
            eventStatus: "failure",
            metadata: {
              bundleVersion: bundle.bundleVersion,
              reason: error instanceof Error ? error.message : "Unknown error",
            },
          });
          throw error;
        }

        await dependencies.auditService.record({
          accountId: accountId ?? null,
          workspaceId,
          eventType: "agent.bundle.imported",
          eventStatus: "success",
          metadata: {
            agentId: result.agentId,
            bundleVersion: bundle.bundleVersion,
            unresolvedCount: result.unresolved.length,
            unresolvedKinds: [...new Set(result.unresolved.map((entry) => entry.kind))],
          },
        });

        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
