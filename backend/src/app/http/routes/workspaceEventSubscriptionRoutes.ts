import { Router, type Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import type { AuthenticatedPrincipal } from "../../../modules/account/public.js";
import { WORKSPACE_EVENT_SUBSCRIPTIONS_MANAGE_PERMISSION } from "../../../modules/workspaceEventLog/public.js";
import { WORKSPACE_EVENT_TYPES } from "../../../shared/domain/workspaceEventLog.js";
import {
  EVENT_SUBSCRIPTION_LABELS,
  type EventSubscriptionCreator,
} from "../../../shared/domain/workspaceEventSubscriptions.js";
import { holdsWorkspacePermission, requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { parseParams, validateBody } from "../middleware/validate.js";

type EventSubscriptionRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "workspaceEventSubscriptions">;

export const createEventSubscriptionBodySchema = z.object({
  targetUrl: z.string().trim().min(1).max(2048)
    .describe("The https URL each event is POSTed to, without a username or password. Its host must resolve to a public address. Never returned after this response. Subscribing a URL the workspace already subscribed replaces that subscription with a new one under a new id."),
  eventTypes: z.array(z.enum(WORKSPACE_EVENT_TYPES)).min(1).max(WORKSPACE_EVENT_TYPES.length)
    .describe("The event types to receive. Each needs the permission that reads it from the event log."),
  label: z.enum(EVENT_SUBSCRIPTION_LABELS).describe("Which client registered it: `zapier`, `n8n`, or `custom`. Shown in Settings."),
}).strict();

export const eventSubscriptionParamsSchema = z.object({
  subscriptionId: z.string().uuid(),
}).strict();

/** The caller a new subscription's pushes are re-checked against: its credential, or the teammate. */
const creatorOf = (res: Response): EventSubscriptionCreator => {
  const { authPrincipal, userId } = res.locals as { authPrincipal?: AuthenticatedPrincipal; userId?: string };
  if (authPrincipal?.type === "service_account_credential") {
    return { kind: "service_account", credentialId: authPrincipal.credentialId, serviceAccountId: authPrincipal.serviceAccountId };
  }
  if (authPrincipal?.type === "personal_api_credential") {
    return { kind: "personal_token", credentialId: authPrincipal.credentialId, userId: authPrincipal.userId };
  }
  return { kind: "teammate", userId: authPrincipal?.type === "session_user" ? authPrincipal.userId : userId! };
};

/**
 * Event subscriptions (#1852) at `/api/v1/workspace/event-subscriptions`: a receiver subscribes its
 * URL with a token, and receives each event of its types as a signed POST until it unsubscribes.
 */
export const createWorkspaceEventSubscriptionRoutes = (dependencies: EventSubscriptionRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const manage = requireWorkspacePermission(dependencies, WORKSPACE_EVENT_SUBSCRIPTIONS_MANAGE_PERMISSION);

  router.post("/", workspaceSession, manage, validateBody(createEventSubscriptionBodySchema), async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createEventSubscriptionBodySchema>;
      const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
      const created = await dependencies.workspaceEventSubscriptions.create({
        workspaceId,
        actor: { accountId },
        createdBy: creatorOf(res),
        targetUrl: body.targetUrl,
        eventTypes: body.eventTypes,
        label: body.label,
        permits: async (permissions) => {
          for (const permission of permissions) {
            if (!(await holdsWorkspacePermission(dependencies, res, permission))) return false;
          }
          return true;
        },
      });
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  router.get("/", workspaceSession, manage, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      res.status(200).json({ subscriptions: await dependencies.workspaceEventSubscriptions.list(workspaceId) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:subscriptionId", workspaceSession, manage, async (req, res, next) => {
    try {
      const { subscriptionId } = parseParams(eventSubscriptionParamsSchema, req.params);
      const { workspaceId } = res.locals as { workspaceId: string };
      res.status(200).json({ subscription: await dependencies.workspaceEventSubscriptions.get(workspaceId, subscriptionId) });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:subscriptionId", workspaceSession, manage, async (req, res, next) => {
    try {
      const { subscriptionId } = parseParams(eventSubscriptionParamsSchema, req.params);
      const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
      await dependencies.workspaceEventSubscriptions.delete(workspaceId, subscriptionId, { accountId });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
