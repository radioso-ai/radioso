import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { parseParams, parseQuery, validateBody } from "../middleware/validate.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { CONTEXT_VARIABLES_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ContextValueWriter, ContextVariableScope } from "../../../modules/context-variables/public.js";
import {
  CONTEXT_VARIABLE_SCOPE_TYPES,
  CONTEXT_VARIABLE_SOURCES,
  CONTEXT_VARIABLE_VALUE_TYPES,
  contextVariableOptionInputSchema,
  deriveVisitorIdentitySigningKey,
  normalizeContextVariableOption,
} from "../../../modules/context-variables/public.js";
import type { AuthenticatedPrincipal } from "../../../modules/account/services/accountAccessService.js";

const contextVariableTrustTiers = ["unverified", "signed"] as const;
const contextVariableSensitivities = ["normal", "sensitive"] as const;
const contextVariableSurfacings = ["always", "on_reference", "operator_only"] as const;
const optionLimits = CONTEXT_VARIABLES_BEHAVIOR.enumOptions;

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

// The context-variable module also checks that keys are unique and that no stored key is dropped.
const contextVariableOptionSchema = contextVariableOptionInputSchema.transform(normalizeContextVariableOption);

const contextVariableBodySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  valueType: z.enum(CONTEXT_VARIABLE_VALUE_TYPES),
  options: z.array(contextVariableOptionSchema).max(optionLimits.maxOptions).nullable().optional(),
  trustTier: z.enum(contextVariableTrustTiers),
  sensitivity: z.enum(contextVariableSensitivities),
  defaultSurfacing: z.enum(contextVariableSurfacings),
}).strict();

const contextVariablePatchBodySchema = contextVariableBodySchema.partial().strict();

const contextVariableParamsSchema = z.object({
  id: z.string().uuid(),
});

const agentContextVariableParamsSchema = z.object({
  agentId: z.string().uuid(),
  variableId: z.string().uuid(),
});

/** A `conversation` scope is keyed by the conversation's id. */
const conversationScopeIdIssue = (scope: { type: string; id: string }, ctx: z.RefinementCtx, path: string): void => {
  if (scope.type === "conversation" && !z.string().uuid().safeParse(scope.id).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "A conversation scope id is the conversation's id" });
  }
};

const contextVariableValueQuerySchema = z.object({
  scopeType: z.enum(CONTEXT_VARIABLE_SCOPE_TYPES),
  scopeId: z.string().min(1).max(500),
}).superRefine((query, ctx) => conversationScopeIdIssue({ type: query.scopeType, id: query.scopeId }, ctx, "scopeId"));

const contextVariableScopeSchema = z.object({
  type: z.enum(CONTEXT_VARIABLE_SCOPE_TYPES),
  id: z.string().min(1).max(500),
}).strict().superRefine((scope, ctx) => conversationScopeIdIssue(scope, ctx, "id"));

const contextVariableValueBodySchema = z.object({
  scope: contextVariableScopeSchema,
  data: jsonValueSchema,
}).strict();

const contextVariableValueDeleteBodySchema = z.object({
  scope: contextVariableScopeSchema,
}).strict();

const agentContextVariableEnablementBodySchema = z.object({
  source: z.enum(CONTEXT_VARIABLE_SOURCES),
  resolverSkillId: z.string().uuid().nullable().optional(),
  maxAgeSeconds: z.number().int().nonnegative().nullable().optional(),
  resolverTimeoutMs: z.number().int().positive().nullable().optional(),
  surfacing: z.enum(contextVariableSurfacings),
  enabled: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.source === "browser") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source"],
      message: "browser-sourced context variables are not yet supported",
    });
    return;
  }

  // visitor_request (the only request-sourced built-in) resolves unconditionally from
  // the conversation, like page_context and visitor_identity — there is no per-agent
  // enablement row to create.
  if (value.source === "request") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source"],
      message: "request-sourced context variables are not yet supported",
    });
    return;
  }

  if (value.source === "resolver") {
    if (!value.resolverSkillId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolverSkillId"],
        message: "resolverSkillId is required when source is resolver",
      });
    }
    return;
  }

  if (value.resolverSkillId !== undefined && value.resolverSkillId !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["resolverSkillId"],
      message: "resolverSkillId is only allowed when source is resolver",
    });
  }
  if (value.maxAgeSeconds !== undefined && value.maxAgeSeconds !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxAgeSeconds"],
      message: "maxAgeSeconds is only allowed when source is resolver",
    });
  }
  if (value.resolverTimeoutMs !== undefined && value.resolverTimeoutMs !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["resolverTimeoutMs"],
      message: "resolverTimeoutMs is only allowed when source is resolver",
    });
  }
});

/** An API value write names the credential that made it, or the teammate whose session did. */
const apiWriterFor = (principal: AuthenticatedPrincipal | undefined): ContextValueWriter => {
  if (principal?.type === "personal_api_credential" || principal?.type === "service_account_credential") {
    return { kind: "api", ref: principal.credentialId };
  }
  return { kind: "api", ref: principal?.type === "session_user" ? principal.userId : null };
};

type ContextVariableRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  "accountAccessService" | "contextVariableService" | "env"
>;

export const createContextVariableRoutes = (dependencies: ContextVariableRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const contextRead = requireWorkspacePermission(dependencies, "workspace.agents.read");
  const contextManage = requireWorkspacePermission(dependencies, "workspace.agents.manage");

  router.post(
    "/context-variables",
    workspaceSession,
    contextManage,
    validateBody(contextVariableBodySchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const contextVariable = await dependencies.contextVariableService.create({
          workspaceId,
          ...req.body,
        });
        res.status(201).json({ contextVariable });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/context-variables", workspaceSession, contextRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const contextVariables = await dependencies.contextVariableService.listByWorkspace(workspaceId);
      res.status(200).json({ contextVariables });
    } catch (error) {
      next(error);
    }
  });

  router.get("/context-variables/:id", workspaceSession, contextRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { id } = parseParams(contextVariableParamsSchema, req.params);
      const contextVariable = await dependencies.contextVariableService.requireVariable(workspaceId, id);
      res.status(200).json({ contextVariable });
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    "/context-variables/:id",
    workspaceSession,
    contextManage,
    validateBody(contextVariablePatchBodySchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const { id } = parseParams(contextVariableParamsSchema, req.params);
        const contextVariable = await dependencies.contextVariableService.update(workspaceId, id, req.body);
        if (!contextVariable) {
          throw notFound("Context variable not found");
        }
        res.status(200).json({ contextVariable });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/context-variables/:id", workspaceSession, contextManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { id } = parseParams(contextVariableParamsSchema, req.params);
      const deleted = await dependencies.contextVariableService.delete(workspaceId, id);
      if (!deleted) {
        throw notFound("Context variable not found");
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get("/agents/:agentId/context-variables", workspaceSession, contextRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { agentId } = parseParams(z.object({ agentId: z.string().uuid() }), req.params);
      const enablements = await dependencies.contextVariableService.listByAgent(workspaceId, agentId);
      res.status(200).json({ enablements });
    } catch (error) {
      next(error);
    }
  });

  router.get("/agents/:agentId/context-variables/signing-key", workspaceSession, contextManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { agentId } = parseParams(z.object({ agentId: z.string().uuid() }), req.params);
      await dependencies.contextVariableService.requireAgent(workspaceId, agentId);
      if (!dependencies.env.WORKSPACE_TOKEN_SECRET) {
        throw badRequest("Workspace token signing is not configured");
      }
      res.status(200).json({
        signingKey: deriveVisitorIdentitySigningKey(
          dependencies.env.WORKSPACE_TOKEN_SECRET,
          workspaceId,
          agentId,
        ).toString("hex"),
      });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    "/agents/:agentId/context-variables/:variableId",
    workspaceSession,
    contextManage,
    validateBody(agentContextVariableEnablementBodySchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const { agentId, variableId } = parseParams(agentContextVariableParamsSchema, req.params);
        const enablement = await dependencies.contextVariableService.upsertEnablement({
          workspaceId,
          agentId,
          variableId,
          source: req.body.source,
          resolverSkillId: req.body.resolverSkillId ?? null,
          maxAgeSeconds: req.body.maxAgeSeconds ?? null,
          resolverTimeoutMs: req.body.resolverTimeoutMs ?? null,
          surfacing: req.body.surfacing,
          enabled: req.body.enabled ?? true,
        });
        res.status(200).json({ enablement });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/agents/:agentId/context-variables/:variableId", workspaceSession, contextManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { agentId, variableId } = parseParams(agentContextVariableParamsSchema, req.params);
      const deleted = await dependencies.contextVariableService.deleteEnablement(workspaceId, agentId, variableId);
      if (!deleted) {
        throw notFound("Context variable enablement not found");
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.put(
    "/context-variables/:id/values",
    workspaceSession,
    contextManage,
    validateBody(contextVariableValueBodySchema),
    async (req, res, next) => {
      try {
        const { workspaceId, authPrincipal } = res.locals as { workspaceId: string; authPrincipal?: AuthenticatedPrincipal };
        const { id } = parseParams(contextVariableParamsSchema, req.params);
        const value = await dependencies.contextVariableService.upsertValue(
          workspaceId,
          id,
          req.body.scope,
          req.body.data,
          apiWriterFor(authPrincipal),
        );
        res.status(200).json({ value });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/context-variables/:id/values", workspaceSession, contextRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { id } = parseParams(contextVariableParamsSchema, req.params);
      const query = parseQuery(contextVariableValueQuerySchema, req.query);
      const scope: ContextVariableScope = { type: query.scopeType, id: query.scopeId };
      const value = await dependencies.contextVariableService.readValue(workspaceId, id, scope);
      if (!value) {
        throw notFound("Context variable value not found");
      }
      res.status(200).json({ value });
    } catch (error) {
      next(error);
    }
  });

  router.delete(
    "/context-variables/:id/values",
    workspaceSession,
    contextManage,
    validateBody(contextVariableValueDeleteBodySchema),
    async (req, res, next) => {
      try {
        const { workspaceId, authPrincipal } = res.locals as { workspaceId: string; authPrincipal?: AuthenticatedPrincipal };
        const { id } = parseParams(contextVariableParamsSchema, req.params);
        const deleted = await dependencies.contextVariableService.deleteValue(workspaceId, id, req.body.scope, apiWriterFor(authPrincipal));
        if (!deleted) {
          throw notFound("Context variable value not found");
        }
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
