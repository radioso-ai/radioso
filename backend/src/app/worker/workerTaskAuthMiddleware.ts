import { createHash, timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

import { WORKER_TASK_AUTH_HEADER_LOWERCASE } from "../../shared/infra/workerTaskAuth.js";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

export const createWorkerTaskAuthMiddleware = (configuredToken: string | undefined): RequestHandler => {
  const configuredDigest = digest(configuredToken ?? "");

  return (req, res, next) => {
    const headerValue = req.headers[WORKER_TASK_AUTH_HEADER_LOWERCASE];
    const suppliedToken = typeof headerValue === "string" ? headerValue : "";
    const tokenMatches = timingSafeEqual(configuredDigest, digest(suppliedToken));

    if (!configuredToken || !tokenMatches) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    next();
  };
};
