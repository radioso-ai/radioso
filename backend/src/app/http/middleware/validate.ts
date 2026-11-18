import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { z, ZodTypeAny } from "zod";

import { badRequest } from "../../../shared/domain/errors.js";

export const validateQuery = <T extends ZodTypeAny>(schema: T): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query);

    if (!parsed.success) {
      next(badRequest("Invalid request query", parsed.error.flatten()));
      return;
    }

    req.query = parsed.data as Request["query"];
    next();
  };
};

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

/** Parse `req.params` inside a handler; a malformed path parameter is a 400, never an internal error. */
export const parseParams = <T extends z.ZodObject>(schema: T, params: unknown): z.infer<T> => {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw badRequest("Invalid route parameters", parsed.error.flatten());
  }
  return parsed.data;
};

/** Parse `req.query` inside a handler; see `parseParams`. */
export const parseQuery = <T extends z.ZodObject>(schema: T, query: unknown): z.infer<T> => {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw badRequest("Invalid query parameters", parsed.error.flatten());
  }
  return parsed.data;
};
