import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny } from "zod";

import { badRequest } from "../../../shared/domain/errors.js";

export const validateBody = <T extends ZodTypeAny>(schema: T): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      next(badRequest("Invalid request body", parsed.error.flatten()));
      return;
    }

    req.body = parsed.data;
    next();
  };
};
