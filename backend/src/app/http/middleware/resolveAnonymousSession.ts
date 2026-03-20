import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { notFound } from "../../../shared/domain/errors.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";

const COOKIE_NAME = "anon_session";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

export const resolveAnonymousSession = (workspaceRepository: WorkspaceRepositoryPort): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.params.token;

      if (!token) {
        next(notFound("Not found"));
        return;
      }

      const workspace = await workspaceRepository.findByAnonymousChatToken(token);

      if (!workspace || !workspace.anonymousChatEnabled) {
        next(notFound("Not found"));
        return;
      }

      let sessionId = req.cookies?.[COOKIE_NAME] as string | undefined;

      if (!sessionId) {
        sessionId = randomUUID();
        res.cookie(COOKIE_NAME, sessionId, {
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
