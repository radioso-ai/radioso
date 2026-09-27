import type { RequestHandler } from "express";

import { badRequest } from "../../../shared/domain/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A same-site form submission cannot set a custom header or a `Content-Type` of
 * `application/json`, so this closes the gap `requireApiAccessCsrf` leaves open on a route whose
 * body doubles as a forgeable form (a bare `reviewDigest` field): the CSRF header proves the
 * caller is not a plain HTML form, and this proves the parsed body did not arrive as one either.
 */
export const requireJsonContentType: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }
  if (!/^application\/json\b/i.test(req.header("content-type") ?? "")) {
    next(badRequest("This endpoint requires an application/json request body"));
    return;
  }
  next();
};
