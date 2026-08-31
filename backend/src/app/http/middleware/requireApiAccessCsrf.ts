import type { RequestHandler } from "express";

import { forbidden } from "../../../shared/domain/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const requireApiAccessCsrf: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }
  if (req.header("x-radioso-csrf") !== "1") {
    next(forbidden("CSRF protection header is required"));
    return;
  }
  next();
};
