import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { forbidden } from "../../../shared/domain/errors.js";
import { requireDashboardWorkspaceSession } from "../middleware/requireDashboardWorkspaceSession.js";
import { requireApiAccessCsrf } from "../middleware/requireApiAccessCsrf.js";
import { validateBody } from "../middleware/validate.js";
import { presentApiCredential, presentServiceAccount } from "../presenters/apiAccessPresenter.js";
import { apiAccessCredentialParamsSchema, apiAccessPageQuerySchema, apiAccessServiceAccountParamsSchema, apiAccessServiceCredentialParamsSchema, apiAccessWorkspaceParamsSchema, credentialRotateSchema, credentialUpdateSchema, lifecycleRevisionSchema, personalCredentialIssueSchema, serviceAccountCreateSchema, serviceAccountUpdateSchema, serviceCredentialIssueSchema } from "../schemas/apiAccessSchemas.js";

type Dependencies = Pick<AppDependencies, "env" | "authService" | "accountAccessService" | "workspaceSessionService" | "personalCredentialService" | "serviceAccountService">;

const requireRouteWorkspace = (requestedWorkspaceId: string, resolvedWorkspaceId: string): void => {
  if (requestedWorkspaceId !== resolvedWorkspaceId) throw forbidden();
};

export const createApiAccessRoutes = (dependencies: Dependencies): Router => {
  const router = Router();
  const dashboardSession = requireDashboardWorkspaceSession(dependencies);

  router.post("/workspaces/:workspaceId/api-access/personal-tokens", dashboardSession, requireApiAccessCsrf, validateBody(personalCredentialIssueSchema), async (req, res, next) => {
    try {
      const { workspaceId } = apiAccessWorkspaceParamsSchema.parse(req.params);
      const locals = res.locals as { accountId: string; userId: string; workspaceId: string };
      requireRouteWorkspace(workspaceId, locals.workspaceId);
      const issued = await dependencies.personalCredentialService.issue({ accountId: locals.accountId, workspaceId, userId: locals.userId, ...req.body });
      res.status(201).json({ credential: presentApiCredential(issued.credential), secret: issued.secret });
    } catch (error) { next(error); }
  });

  router.get("/workspaces/:workspaceId/api-access/personal-tokens", dashboardSession, async (req, res, next) => {
    try {
      const { workspaceId } = apiAccessWorkspaceParamsSchema.parse(req.params);
      const query = apiAccessPageQuerySchema.parse(req.query);
      const locals = res.locals as { accountId: string; userId: string; workspaceId: string };
      requireRouteWorkspace(workspaceId, locals.workspaceId);
      const credentials = query.view === "workspace"
        ? await dependencies.personalCredentialService.listWorkspace({ accountId: locals.accountId as string, workspaceId, actorUserId: locals.userId, page: query.page, limit: query.limit })
        : await dependencies.personalCredentialService.listOwn({ accountId: locals.accountId, workspaceId, userId: locals.userId, page: query.page, limit: query.limit });
      res.status(200).json({ items: credentials.items.map(presentApiCredential), page: query.page, limit: query.limit, total: credentials.total });
    } catch (error) { next(error); }
  });

  router.get("/workspaces/:workspaceId/api-access", dashboardSession, async (req, res, next) => {
    try {
      const { workspaceId } = apiAccessWorkspaceParamsSchema.parse(req.params);
      const l = res.locals as { accountId: string; userId: string; workspaceId: string };
      requireRouteWorkspace(workspaceId, l.workspaceId);
      const effectiveRole = await dependencies.accountAccessService.resolveWorkspaceRole({
        accountId: l.accountId,
        userId: l.userId,
        workspaceId,
      });
      if (!effectiveRole) throw forbidden();
      const can = (permission: "workspace.api_access.personal.manage" | "workspace.api_access.personal.audit" | "workspace.api_access.service.manage") =>
        dependencies.accountAccessService.hasPermission({
          accountId: l.accountId,
          userId: l.userId,
          permission,
          workspaceId,
        });
      const [manageOwnPersonalTokens, auditWorkspacePersonalTokens, manageServiceAccounts, legacyCredentialMigration] = await Promise.all([
        can("workspace.api_access.personal.manage"),
        can("workspace.api_access.personal.audit"),
        can("workspace.api_access.service.manage"),
        dependencies.personalCredentialService.legacyMigrationStatus(workspaceId),
      ]);
      res.json({
        effectiveRole,
        capabilities: { manageOwnPersonalTokens, auditWorkspacePersonalTokens, manageServiceAccounts },
        defaults: { personalTokenLifetimeDays: 90, serviceCredentialLifetimeDays: 365 },
        limits: { personalTokensPerUser: 10, serviceAccountsPerWorkspace: 50, credentialsPerServiceAccount: 5, maximumPageSize: 100 },
        legacyCredentialMigration,
      });
    } catch (error) { next(error); }
  });
  router.patch("/workspaces/:workspaceId/api-access/personal-tokens/:credentialId", dashboardSession, requireApiAccessCsrf, validateBody(credentialUpdateSchema), async (req, res, next) => {
    try { const { workspaceId, credentialId } = apiAccessCredentialParamsSchema.parse(req.params); const l = res.locals as { accountId: string; userId: string; workspaceId: string }; requireRouteWorkspace(workspaceId, l.workspaceId); const credential = await dependencies.personalCredentialService.relabel({ accountId: l.accountId, workspaceId, userId: l.userId, credentialId, ...req.body }); res.json(presentApiCredential(credential)); } catch (error) { next(error); }
  });
  router.post("/workspaces/:workspaceId/api-access/personal-tokens/:credentialId/rotate", dashboardSession, requireApiAccessCsrf, validateBody(credentialRotateSchema), async (req, res, next) => {
    try { const { workspaceId, credentialId } = apiAccessCredentialParamsSchema.parse(req.params); const l = res.locals as { accountId: string; userId: string; workspaceId: string }; requireRouteWorkspace(workspaceId, l.workspaceId); const result = await dependencies.personalCredentialService.rotate({ accountId: l.accountId, workspaceId, userId: l.userId, credentialId, ...req.body }); res.status(201).json({ credential: presentApiCredential(result.credential), secret: result.secret }); } catch (error) { next(error); }
  });
  router.post("/workspaces/:workspaceId/api-access/personal-tokens/:credentialId/revoke", dashboardSession, requireApiAccessCsrf, async (req, res, next) => {
    try { const { workspaceId, credentialId } = apiAccessCredentialParamsSchema.parse(req.params); const l = res.locals as { accountId: string; userId: string; workspaceId: string }; requireRouteWorkspace(workspaceId, l.workspaceId); const credential = await dependencies.personalCredentialService.revoke({ accountId: l.accountId, workspaceId, actorUserId: l.userId, credentialId }); res.json(presentApiCredential(credential)); } catch (error) { next(error); }
  });

  router.post("/workspaces/:workspaceId/api-access/service-accounts", dashboardSession, requireApiAccessCsrf, validateBody(serviceAccountCreateSchema), async (req, res, next) => {
    try {
      const { workspaceId } = apiAccessWorkspaceParamsSchema.parse(req.params);
      const locals = res.locals as { accountId: string; userId: string; workspaceId: string };
      requireRouteWorkspace(workspaceId, locals.workspaceId);
      const created = await dependencies.serviceAccountService.createWithCredential({ accountId: locals.accountId, workspaceId, actorUserId: locals.userId, displayName: req.body.displayName, role: req.body.role, expiresAt: req.body.credentialExpiresAt });
      res.status(201).json({ serviceAccount: presentServiceAccount(created.account), credential: presentApiCredential(created.credential), secret: created.secret });
    } catch (error) { next(error); }
  });

  router.get("/workspaces/:workspaceId/api-access/service-accounts", dashboardSession, async (req, res, next) => {
    try { const { workspaceId } = apiAccessWorkspaceParamsSchema.parse(req.params); const query = apiAccessPageQuerySchema.parse(req.query); const l = res.locals as { accountId: string; userId: string; workspaceId: string }; requireRouteWorkspace(workspaceId, l.workspaceId); const accounts = await dependencies.serviceAccountService.list({ accountId: l.accountId, workspaceId, actorUserId: l.userId, page: query.page, limit: query.limit }); res.json({ items: accounts.items.map(presentServiceAccount), page: query.page, limit: query.limit, total: accounts.total }); } catch (error) { next(error); }
  });
  router.get("/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId", dashboardSession, async (req, res, next) => {
    try { const { workspaceId, serviceAccountId } = apiAccessServiceAccountParamsSchema.parse(req.params); const l = res.locals as { accountId: string; userId: string; workspaceId: string }; requireRouteWorkspace(workspaceId, l.workspaceId); res.json(presentServiceAccount(await dependencies.serviceAccountService.get({ accountId: l.accountId, workspaceId, actorUserId: l.userId, serviceAccountId }))); } catch (error) { next(error); }
  });
  router.patch("/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId", dashboardSession, requireApiAccessCsrf, validateBody(serviceAccountUpdateSchema), async (req, res, next) => {
    try { const { workspaceId, serviceAccountId } = apiAccessServiceAccountParamsSchema.parse(req.params); const l = res.locals as { accountId: string; userId: string; workspaceId: string }; requireRouteWorkspace(workspaceId, l.workspaceId); const account = await dependencies.serviceAccountService.update({ accountId: l.accountId, workspaceId, actorUserId: l.userId, serviceAccountId, ...req.body }); res.json(presentServiceAccount(account)); } catch (error) { next(error); }
  });
  for (const [action, status] of [["disable", "disabled"], ["enable", "enabled"], ["archive", "archived"]] as const) {
    router.post(`/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId/${action}`, dashboardSession, requireApiAccessCsrf, validateBody(lifecycleRevisionSchema), async (req, res, next) => {
      try { const { workspaceId, serviceAccountId } = apiAccessServiceAccountParamsSchema.parse(req.params); const l = res.locals as { accountId: string; userId: string; workspaceId: string }; requireRouteWorkspace(workspaceId, l.workspaceId); const account = await dependencies.serviceAccountService.update({ accountId: l.accountId, workspaceId, actorUserId: l.userId, serviceAccountId, revision: req.body.revision, status }); res.json(presentServiceAccount(account)); } catch (error) { next(error); }
    });
  }

  router.post("/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId/credentials", dashboardSession, requireApiAccessCsrf, validateBody(serviceCredentialIssueSchema), async (req, res, next) => {
    try {
      const { workspaceId, serviceAccountId } = apiAccessServiceAccountParamsSchema.parse(req.params);
      const locals = res.locals as { accountId: string; userId: string; workspaceId: string };
      requireRouteWorkspace(workspaceId, locals.workspaceId);
      const issued = await dependencies.serviceAccountService.issueCredential({ accountId: locals.accountId, workspaceId, actorUserId: locals.userId, serviceAccountId, ...req.body });
      res.status(201).json({ credential: presentApiCredential(issued.credential), secret: issued.secret });
    } catch (error) { next(error); }
  });
  router.get("/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId/credentials", dashboardSession, async (req, res, next) => {
    try { const { workspaceId, serviceAccountId } = apiAccessServiceAccountParamsSchema.parse(req.params); const query = apiAccessPageQuerySchema.parse(req.query); const l = res.locals as { accountId: string; userId: string; workspaceId: string }; requireRouteWorkspace(workspaceId, l.workspaceId); const credentials = await dependencies.serviceAccountService.listCredentials({ accountId: l.accountId, workspaceId, actorUserId: l.userId, serviceAccountId, page: query.page, limit: query.limit }); res.json({ items: credentials.items.map(presentApiCredential), page: query.page, limit: query.limit, total: credentials.total }); } catch (error) { next(error); }
  });
  router.patch("/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId/credentials/:credentialId", dashboardSession, requireApiAccessCsrf, validateBody(credentialUpdateSchema), async (req, res, next) => {
    try { const { workspaceId, serviceAccountId, credentialId } = apiAccessServiceCredentialParamsSchema.parse(req.params); const l = res.locals as { accountId: string; userId: string; workspaceId: string }; requireRouteWorkspace(workspaceId, l.workspaceId); const credential = await dependencies.serviceAccountService.relabelCredential({ accountId: l.accountId, workspaceId, actorUserId: l.userId, serviceAccountId, credentialId, ...req.body }); res.json(presentApiCredential(credential)); } catch (error) { next(error); }
  });
  router.post("/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId/credentials/:credentialId/rotate", dashboardSession, requireApiAccessCsrf, validateBody(credentialRotateSchema), async (req, res, next) => {
    try { const { workspaceId, serviceAccountId, credentialId } = apiAccessServiceCredentialParamsSchema.parse(req.params); const l = res.locals as { accountId: string; userId: string; workspaceId: string }; requireRouteWorkspace(workspaceId, l.workspaceId); const result = await dependencies.serviceAccountService.rotateCredential({ accountId: l.accountId, workspaceId, actorUserId: l.userId, serviceAccountId, credentialId, ...req.body }); res.status(201).json({ credential: presentApiCredential(result.credential), secret: result.secret }); } catch (error) { next(error); }
  });
  router.post("/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId/credentials/:credentialId/revoke", dashboardSession, requireApiAccessCsrf, async (req, res, next) => {
    try { const { workspaceId, serviceAccountId, credentialId } = apiAccessServiceCredentialParamsSchema.parse(req.params); const l = res.locals as { accountId: string; userId: string; workspaceId: string }; requireRouteWorkspace(workspaceId, l.workspaceId); const credential = await dependencies.serviceAccountService.revokeCredential({ accountId: l.accountId, workspaceId, actorUserId: l.userId, serviceAccountId, credentialId }); res.json(presentApiCredential(credential)); } catch (error) { next(error); }
  });
  return router;
};
