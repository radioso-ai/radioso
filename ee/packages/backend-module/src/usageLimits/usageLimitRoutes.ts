import { Router, type RequestHandler } from "express";
import { z } from "zod";

import type { ApplicationRouteMount, UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { EnterpriseUsageLimitService, normalizePeriodStart } from "./usageLimitService.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const profileKeySchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/);
const accountIdSchema = z.string().uuid();
const nullableLimitSchema = z.number().int().min(0).nullable();

const profileBodySchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  monthlyAnswerLimit: nullableLimitSchema,
  storedDocumentLimit: nullableLimitSchema,
});

const assignmentBodySchema = z.object({
  profileKey: profileKeySchema.nullable(),
});

const usageQuerySchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});

const parseRequest = <T>(schema: z.ZodType<T>, value: unknown, message: string): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw {
    statusCode: 400,
    code: "bad_request",
    message,
    details: parsed.error.flatten(),
  };
};

const requireAdminToken = (): RequestHandler => (req, res, next) => {
  const expectedToken = process.env.EE_USAGE_ADMIN_TOKEN;
  if (!expectedToken) {
    res.status(503).json({
      error: {
        code: "service_unavailable",
        message: "EE usage limit admin API is not configured.",
        details: { missingEnv: "EE_USAGE_ADMIN_TOKEN" },
      },
    });
    return;
  }

  const authorization = req.header("authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
  if (bearerToken !== expectedToken) {
    res.status(401).json({
      error: {
        code: "unauthorized",
        message: "Unauthorized",
      },
    });
    return;
  }

  next();
};

const isRouteDependencies = (
  input: RouteDependencies | UsageLimitDatabasePort,
): input is RouteDependencies =>
  "connectorDb" in input && "authService" in input && "accountAccessService" in input;

const requireAccountSession = (dependencies: RouteDependencies): RequestHandler => async (req, res, next) => {
  try {
    const sessionToken = req.cookies?.[dependencies.env.SESSION_COOKIE_NAME];
    if (typeof sessionToken !== "string" || !sessionToken) {
      throw {
        statusCode: 401,
        code: "unauthorized",
        message: "Unauthorized",
      };
    }

    const session = await dependencies.authService.authenticateSession(sessionToken);
    await dependencies.accountAccessService.requireActiveMembership(session.accountId, session.userId);
    res.locals.accountId = session.accountId;
    res.locals.userId = session.userId;
    res.locals.sessionId = session.sessionId;
    next();
  } catch (error) {
    next(error);
  }
};

export const createUsageLimitRoutes = (input: RouteDependencies | UsageLimitDatabasePort): Router => {
  const router = Router();
  const database = isRouteDependencies(input) ? input.connectorDb : input;
  const service = new EnterpriseUsageLimitService(database);

  if (isRouteDependencies(input)) {
    router.get("/me", requireAccountSession(input), async (req, res, next) => {
      try {
        const query = parseRequest(usageQuerySchema, req.query, "Invalid usage query");
        const { accountId } = res.locals as { accountId: string };
        const usage = await service.getAccountUsage(accountId, normalizePeriodStart(query.period));
        res.status(200).json(usage);
      } catch (error) {
        next(error);
      }
    });
  }

  router.use(requireAdminToken());

  router.get("/profiles", async (_req, res, next) => {
    try {
      res.status(200).json({ profiles: await service.listProfiles() });
    } catch (error) {
      next(error);
    }
  });

  router.put("/profiles/:profileKey", async (req, res, next) => {
    try {
      const profileKey = parseRequest(profileKeySchema, req.params.profileKey, "Invalid profile key");
      const body = parseRequest(profileBodySchema, req.body, "Invalid profile payload");
      const profile = await service.upsertProfile({
        key: profileKey,
        displayName: body.displayName,
        monthlyAnswerLimit: body.monthlyAnswerLimit,
        storedDocumentLimit: body.storedDocumentLimit,
      });
      res.status(200).json({ profile });
    } catch (error) {
      next(error);
    }
  });

  router.put("/accounts/:accountId", async (req, res, next) => {
    try {
      const accountId = parseRequest(accountIdSchema, req.params.accountId, "Invalid account id");
      const body = parseRequest(assignmentBodySchema, req.body, "Invalid assignment payload");
      const usage = await service.assignProfile(accountId, body.profileKey);
      res.status(200).json(usage);
    } catch (error) {
      next(error);
    }
  });

  router.get("/accounts/:accountId/usage", async (req, res, next) => {
    try {
      const accountId = parseRequest(accountIdSchema, req.params.accountId, "Invalid account id");
      const query = parseRequest(usageQuerySchema, req.query, "Invalid usage query");
      const usage = await service.getAccountUsage(accountId, normalizePeriodStart(query.period));
      res.status(200).json(usage);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
