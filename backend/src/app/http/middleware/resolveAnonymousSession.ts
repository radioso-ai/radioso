import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { notFound } from "../../../shared/domain/errors.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
const anonymousTokenParamsSchema = z.object({
  token: z.string().min(1),
});

export const resolveAnonymousSession = (workspaceRepository: WorkspaceRepositoryPort): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedParams = anonymousTokenParamsSchema.safeParse(req.params);

      if (!parsedParams.success) {
        next(notFound("Not found"));
        return;
      }

      const { token } = parsedParams.data;
      const workspace = await workspaceRepository.findByAnonymousChatToken(token);

      if (!workspace || !workspace.anonymousChatEnabled) {
        next(notFound("Not found"));
        return;
      }

      const cookieName = `anon_session_${workspace.id}`;
      let sessionId = req.cookies?.[cookieName] as string | undefined;

      if (!sessionId) {
        sessionId = randomUUID();
        res.cookie(cookieName, sessionId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: COOKIE_MAX_AGE_SECONDS * 1000,
        });
      }

      res.locals.workspaceId = workspace.id;
      res.locals.anonymousSessionId = sessionId;
      res.locals.anonymousRateLimit = workspace.anonymousRateLimit;
      next();
    } catch (error) {
      next(error);
    }
  };
};
