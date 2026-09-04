import { Router } from "express";
import { z } from "zod";

import { requireApiAccessCsrf } from "../../app/http/middleware/requireApiAccessCsrf.js";
import { requireSession } from "../../app/http/middleware/requireSession.js";
import type { AppDependencies } from "../../app/server/types.js";
import { OperatorMcpProtocolError, validateRedirectUri } from "./domain.js";

type Dependencies = Pick<AppDependencies,
  "env" | "authService" | "accountAccessService" | "workspaceService" | "userRepository" |
  "operatorMcpAuthorizationService" | "operatorMcpClientResolver" | "operatorMcpReadiness"
>;

const authorizeQuery = z.object({
  response_type: z.string(), client_id: z.string().min(1).max(2048), redirect_uri: z.string().min(1).max(2048),
  scope: z.string().min(1).max(512), state: z.string().min(1).max(2048), code_challenge: z.string(),
  code_challenge_method: z.string(), resource: z.string().min(1).max(2048),
});
const transactionParams = z.object({ transactionId: z.string().uuid() });
const decisionBody = z.object({
  decision: z.enum(["approve", "deny"]), workspaceId: z.string().uuid().optional(),
  approvedToolScopes: z.array(z.enum(["operator:read", "operator:probe", "operator:act", "operator:propose"])).min(1).max(4).optional(),
  offlineAccess: z.boolean().default(false),
});

const noStore = (_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
};

const oauthError = (error: unknown): string => error instanceof OperatorMcpProtocolError ? error.code : "invalid_request";

export const createOperatorMcpDiscoveryRoutes = (dependencies: Pick<Dependencies, "env">): Router => {
  const router = Router();
  router.get("/oauth-authorization-server", (_req, res) => {
    const issuer = dependencies.env.OPERATOR_MCP_ISSUER_URL;
    if (!dependencies.env.OPERATOR_MCP_ENABLED || !issuer) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json({
      issuer,
      authorization_endpoint: `${issuer}/api/v1/operator-mcp/oauth/authorize`,
      token_endpoint: `${issuer}/api/v1/operator-mcp/oauth/token`,
      revocation_endpoint: `${issuer}/api/v1/operator-mcp/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["operator:read", "operator:probe", "operator:act", "operator:propose", "offline_access"],
    });
  });
  return router;
};

export const createOperatorMcpOauthRoutes = (dependencies: Dependencies): Router => {
  const router = Router();
  const sessionOnly = requireSession(dependencies);
  const service = dependencies.operatorMcpAuthorizationService;

  router.get("/authorize", noStore, async (req, res) => {
    if (!service || !await dependencies.operatorMcpReadiness) {
      res.status(503).json({ error: "temporarily_unavailable" });
      return;
    }
    let trustedRedirect: string | null = null;
    let state: string | null = null;
    try {
      const query = authorizeQuery.parse(req.query);
      state = query.state;
      const client = await dependencies.operatorMcpClientResolver.resolve(query.client_id, query.redirect_uri);
      trustedRedirect = validateRedirectUri({
        applicationType: client.applicationType,
        requested: query.redirect_uri,
        registered: client.redirectUris,
      });
      const started = await service.startAuthorization({
        client, responseType: query.response_type, redirectUri: query.redirect_uri, state: query.state,
        scope: query.scope, codeChallenge: query.code_challenge, codeChallengeMethod: query.code_challenge_method,
        resource: query.resource, now: new Date(),
      });
      res.redirect(302, started.consentUrl);
    } catch (error) {
      if (trustedRedirect && state) {
        const redirect = new URL(trustedRedirect);
        redirect.searchParams.set("error", oauthError(error));
        redirect.searchParams.set("state", state);
        res.redirect(302, redirect.toString());
        return;
      }
      res.status(400).json({ error: oauthError(error) });
    }
  });

  router.post("/token", noStore, async (req, res) => {
    if (!service || !await dependencies.operatorMcpReadiness) {
      res.status(503).json({ error: "temporarily_unavailable" });
      return;
    }
    try {
      const body = z.record(z.string(), z.string()).parse(req.body);
      if (body.grant_type === "authorization_code") {
        const result = await service.exchangeAuthorizationCode({
          code: body.code ?? "", clientId: body.client_id ?? "", redirectUri: body.redirect_uri ?? "",
          codeVerifier: body.code_verifier ?? "", resource: body.resource ?? "", scope: body.scope, now: new Date(),
        });
        res.status(200).json({ access_token: result.accessToken, token_type: result.tokenType, expires_in: result.expiresIn, refresh_token: result.refreshToken ?? undefined, scope: result.scope });
        return;
      }
      if (body.grant_type === "refresh_token") {
        const result = await service.refresh({ refreshToken: body.refresh_token ?? "", clientId: body.client_id ?? "", resource: body.resource ?? "", scope: body.scope, now: new Date() });
        res.status(200).json({ access_token: result.accessToken, token_type: result.tokenType, expires_in: result.expiresIn, refresh_token: result.refreshToken, scope: result.scope });
        return;
      }
      throw new OperatorMcpProtocolError("unsupported_grant_type", "unsupported_grant_type");
    } catch (error) {
      res.status(400).json({ error: oauthError(error) });
    }
  });

  router.post("/revoke", noStore, async (req, res) => {
    if (!service || !await dependencies.operatorMcpReadiness) {
      res.status(503).json({ error: "temporarily_unavailable" });
      return;
    }
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    await service.revoke(token, new Date()).catch(() => undefined);
    res.status(200).end();
  });

  router.get("/transactions/:transactionId", noStore, sessionOnly, async (req, res, next) => {
    try {
      if (!service) throw new OperatorMcpProtocolError("invalid_request", "invalid_request");
      const { transactionId } = transactionParams.parse(req.params);
      const locals = res.locals as { userId: string; accountId: string; sessionId: string };
      const transaction = await service.getTransaction(transactionId, new Date());
      if ((transaction.userId && transaction.userId !== locals.userId)
        || (transaction.accountId && transaction.accountId !== locals.accountId)
        || (transaction.sessionId && transaction.sessionId !== locals.sessionId)) {
        throw new OperatorMcpProtocolError("invalid_request", "invalid_request");
      }
      const [user, workspaces] = await Promise.all([
        dependencies.userRepository.findById(locals.userId),
        dependencies.workspaceService.listForAccount(locals.accountId),
      ]);
      const accessible = (await Promise.all(workspaces.map(async (workspace) => ({
        workspace,
        role: await dependencies.accountAccessService.resolveWorkspaceRole({ accountId: locals.accountId, userId: locals.userId, workspaceId: workspace.id }),
      })))).filter((item) => item.role !== null);
      res.status(200).json({
        transactionId: transaction.id,
        client: {
          clientId: transaction.clientId, displayName: transaction.clientDisplayName, clientUri: null,
          clientVersion: transaction.clientVersion, metadataDigest: transaction.clientMetadataDigest,
          applicationType: transaction.applicationType,
        },
        requestedScopes: transaction.requestedToolScopes,
        requestedOfflineAccess: transaction.requestedOfflineAccess,
        redirectHost: new URL(transaction.redirectUri).host,
        redirectUri: transaction.redirectUri,
        resource: transaction.resource,
        currentUser: { id: locals.userId, displayName: user?.email ?? "Current user", email: user?.email ?? null },
        workspaces: accessible.map(({ workspace, role }) => ({ id: workspace.id, name: workspace.name, role })),
        status: transaction.status,
        expiresAt: transaction.expiresAt.toISOString(),
      });
    } catch (error) { next(error); }
  });

  router.post("/transactions/:transactionId/decision", noStore, sessionOnly, requireApiAccessCsrf, async (req, res, next) => {
    try {
      if (!service) throw new OperatorMcpProtocolError("invalid_request", "invalid_request");
      const { transactionId } = transactionParams.parse(req.params);
      const body = decisionBody.parse(req.body);
      const locals = res.locals as { userId: string; accountId: string; sessionId: string };
      const membership = await dependencies.accountAccessService.requireActiveMembership(locals.accountId, locals.userId);
      if (body.decision === "approve") {
        const role = body.workspaceId ? await dependencies.accountAccessService.resolveWorkspaceRole({ accountId: locals.accountId, userId: locals.userId, workspaceId: body.workspaceId }) : null;
        if (!role) throw new OperatorMcpProtocolError("invalid_request", "invalid_request");
      }
      res.status(200).json(await service.decide({
        transactionId, decision: body.decision, sessionId: locals.sessionId, accountId: locals.accountId,
        userId: locals.userId, workspaceId: body.workspaceId, membershipId: membership.id,
        approvedToolScopes: body.approvedToolScopes, approvedOfflineAccess: body.offlineAccess, now: new Date(),
      }));
    } catch (error) { next(error); }
  });

  return router;
};
