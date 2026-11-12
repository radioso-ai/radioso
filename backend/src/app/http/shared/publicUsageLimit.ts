import type { Response } from "express";

import { isUsageLimitExceededError, USAGE_LIMIT_EXCEEDED_CODE } from "../../../shared/domain/usageLimitPolicy.js";

/**
 * Answers a usage-limit refusal on a public route with the bare code and message, and reports
 * whether it did. Its `details` (profileKey, limit, used, period) describe the customer's plan; an
 * anonymous visitor is not the customer, unlike the caller of an authenticated route, which keeps
 * them.
 */
export const answeredPublicUsageLimit = (res: Response, error: unknown): boolean => {
  if (!isUsageLimitExceededError(error)) return false;
  res.status(429).json({ error: { code: USAGE_LIMIT_EXCEEDED_CODE, message: error.message ?? "Usage limit exceeded" } });
  return true;
};
