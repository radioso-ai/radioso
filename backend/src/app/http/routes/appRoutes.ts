import { Router, type Response } from "express";
import { z } from "zod";

import { forbidden, notFound } from "../../../shared/domain/errors.js";
import { appDataDispositions, type AppOperatorPrincipal } from "../../../modules/apps/public.js";
import type { AppDependencies } from "../../server/types.js";
import { APP_ADMINISTRATION_PERMISSION } from "../../composition/apps.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import {
  presentAppInstallation,
  presentAppInstallationPlan,
  presentAppInstallationView,
  presentAppLifecycleOperation,
  presentAppLifecycleOutcome,
  presentAppConnection,
  presentAppRelease,
  presentAppReleaseDetail,
  presentAppsError,
} from "../presenters/appsPresenter.js";

const releaseParams = z.object({ releaseId: z.string().uuid() });
const planParams = z.object({ planId: z.string().uuid() });
const installationParams = z.object({ installationId: z.string().uuid() });

const configurationValue = z.union([z.string(), z.number(), z.boolean()]);
const idempotencyKey = z.string().min(1).max(200);
const expectedVersion = z.number().int().positive();

// Strict: Release A attaches an App to a workspace, and agent-level attachment arrives
// with tools. A request that names target agents is asking for authority this surface
// cannot grant, so it is refused rather than silently dropped.
const planBodySchema = z.object({
  releaseId: z.string().uuid(),
  configuration: z.record(configurationValue).default({}),
}).strict();

const applyBodySchema = z.object({
  checksum: z.string().min(1),
  expectedInstallationVersion: z.number().int().positive().nullable().default(null),
  idempotencyKey,
});

const connectionBodySchema = z.object({
  slotId: z.string().min(1),
  values: z.record(z.unknown()).default({}),
  expectedVersion,
  idempotencyKey,
});

const configurationBodySchema = z.object({
  configuration: z.record(configurationValue),
  expectedVersion,
  idempotencyKey,
});

const lifecycleBodySchema = z.object({
  expectedVersion,
  idempotencyKey,
});

const removeBodySchema = lifecycleBodySchema.extend({
  disposition: z.enum(appDataDispositions),
});

/**
 * Who is asking, read from the authenticated request rather than from the body. The
 * lifecycle saga persists this and re-checks it on every later step, so it has to be a
 * real identity the account service can resolve again.
 */
const operatorPrincipal = (res: Response): AppOperatorPrincipal => {
  const { accountId, userId } = res.locals as { accountId?: string; userId?: string };
  if (!accountId || !userId) {
    throw forbidden("App administration needs an identified workspace operator");
  }
  return { accountId, userId };
};

const workspaceOf = (res: Response): string => {
  const { workspaceId } = res.locals as { workspaceId?: string };
  if (!workspaceId) throw notFound("Workspace not found");
  return workspaceId;
};

/**
 * The Apps control plane's HTTP surface. Every route is workspace-scoped and gated on
 * the App administration permission; the services behind them re-check the same
 * principal before each protected effect, because a saga outlives its request.
 */
export const createAppRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const appsManage = requireWorkspacePermission(dependencies, APP_ADMINISTRATION_PERMISSION);
  const guarded = [workspaceSession, appsManage] as const;

  router.get("/releases", ...guarded, async (_req, res, next) => {
    try {
      const releases = await dependencies.appReleaseAdmissionService.listInstallable();
      res.status(200).json({ items: releases.map(presentAppRelease) });
    } catch (error) {
      next(presentAppsError(error));
    }
  });

  router.get("/releases/:releaseId", ...guarded, async (req, res, next) => {
    try {
      const { releaseId } = releaseParams.parse(req.params);
      const release = await dependencies.appReleaseAdmissionService.findInstallable(releaseId);
      if (!release) throw notFound("App release not found");
      res.status(200).json(presentAppReleaseDetail(release));
    } catch (error) {
      next(presentAppsError(error));
    }
  });

  router.post("/installation-plans", ...guarded, validateBody(planBodySchema), async (req, res, next) => {
    try {
      const body = planBodySchema.parse(req.body);
      const plan = await dependencies.appInstallationPlanService.create({
        workspaceId: workspaceOf(res),
        releaseId: body.releaseId,
        configuration: body.configuration,
        principal: operatorPrincipal(res),
      });
      res.status(201).json(presentAppInstallationPlan(plan));
    } catch (error) {
      next(presentAppsError(error));
    }
  });

  router.get("/installation-plans/:planId", ...guarded, async (req, res, next) => {
    try {
      const { planId } = planParams.parse(req.params);
      const plan = await dependencies.appInstallationPlanService.get(
        workspaceOf(res),
        planId,
        operatorPrincipal(res),
      );
      res.status(200).json(presentAppInstallationPlan(plan));
    } catch (error) {
      next(presentAppsError(error));
    }
  });

  router.post(
    "/installation-plans/:planId/apply",
    ...guarded,
    validateBody(applyBodySchema),
    async (req, res, next) => {
      try {
        const { planId } = planParams.parse(req.params);
        const body = applyBodySchema.parse(req.body);
        const outcome = await dependencies.appInstallationLifecycleService.apply({
          workspaceId: workspaceOf(res),
          planId,
          checksum: body.checksum,
          expectedInstallationVersion: body.expectedInstallationVersion,
          idempotencyKey: body.idempotencyKey,
          principal: operatorPrincipal(res),
        });
        res.status(201).json(presentAppLifecycleOutcome(outcome));
      } catch (error) {
        next(presentAppsError(error));
      }
    },
  );

  router.get("/installations", ...guarded, async (_req, res, next) => {
    try {
      const installations = await dependencies.appInstallationQueryService.list(workspaceOf(res));
      res.status(200).json({ items: installations.map(presentAppInstallation) });
    } catch (error) {
      next(presentAppsError(error));
    }
  });

  router.get("/installations/:installationId", ...guarded, async (req, res, next) => {
    try {
      const { installationId } = installationParams.parse(req.params);
      const view = await dependencies.appInstallationQueryService.get(workspaceOf(res), installationId);
      res.status(200).json(presentAppInstallationView(view));
    } catch (error) {
      next(presentAppsError(error));
    }
  });

  router.get("/installations/:installationId/operations", ...guarded, async (req, res, next) => {
    try {
      const { installationId } = installationParams.parse(req.params);
      const operations = await dependencies.appInstallationQueryService
        .listOperations(workspaceOf(res), installationId);
      res.status(200).json({ items: operations.map(presentAppLifecycleOperation) });
    } catch (error) {
      next(presentAppsError(error));
    }
  });

  router.patch(
    "/installations/:installationId/configuration",
    ...guarded,
    validateBody(configurationBodySchema),
    async (req, res, next) => {
      try {
        const { installationId } = installationParams.parse(req.params);
        const body = configurationBodySchema.parse(req.body);
        const outcome = await dependencies.appInstallationLifecycleService.reconfigure({
          workspaceId: workspaceOf(res),
          installationId,
          configuration: body.configuration,
          expectedVersion: body.expectedVersion,
          idempotencyKey: body.idempotencyKey,
          principal: operatorPrincipal(res),
        });
        res.status(200).json(presentAppLifecycleOutcome(outcome));
      } catch (error) {
        next(presentAppsError(error));
      }
    },
  );

  router.post(
    "/installations/:installationId/connections",
    ...guarded,
    validateBody(connectionBodySchema),
    async (req, res, next) => {
      try {
        const { installationId } = installationParams.parse(req.params);
        const body = connectionBodySchema.parse(req.body);
        const result = await dependencies.appConnectionService.bind({
          workspaceId: workspaceOf(res),
          installationId,
          slotId: body.slotId,
          values: body.values,
          expectedVersion: body.expectedVersion,
          idempotencyKey: body.idempotencyKey,
          principal: operatorPrincipal(res),
        });
        // The only response that ever carries the minted secret. There is no read path
        // that returns it again, so an operator who loses it rotates the slot — and a
        // retry under the same key answers with the same connection and no secret rather
        // than minting a second one.
        res.status(201).json({
          connection: presentAppConnection(result.connection),
          generatedSecret: result.generatedSecret,
          replayed: result.replayed,
        });
      } catch (error) {
        next(presentAppsError(error));
      }
    },
  );

  for (const action of ["activate", "disable", "enable"] as const) {
    router.post(
      `/installations/:installationId/${action}`,
      ...guarded,
      validateBody(lifecycleBodySchema),
      async (req, res, next) => {
        try {
          const { installationId } = installationParams.parse(req.params);
          const body = lifecycleBodySchema.parse(req.body);
          const outcome = await dependencies.appInstallationLifecycleService[action]({
            workspaceId: workspaceOf(res),
            installationId,
            expectedVersion: body.expectedVersion,
            idempotencyKey: body.idempotencyKey,
            principal: operatorPrincipal(res),
          });
          res.status(200).json(presentAppLifecycleOutcome(outcome));
        } catch (error) {
          next(presentAppsError(error));
        }
      },
    );
  }

  router.post(
    "/installations/:installationId/remove",
    ...guarded,
    validateBody(removeBodySchema),
    async (req, res, next) => {
      try {
        const { installationId } = installationParams.parse(req.params);
        const body = removeBodySchema.parse(req.body);
        const outcome = await dependencies.appInstallationLifecycleService.remove({
          workspaceId: workspaceOf(res),
          installationId,
          disposition: body.disposition,
          expectedVersion: body.expectedVersion,
          idempotencyKey: body.idempotencyKey,
          principal: operatorPrincipal(res),
        });
        res.status(200).json(presentAppLifecycleOutcome(outcome));
      } catch (error) {
        next(presentAppsError(error));
      }
    },
  );

  return router;
};
