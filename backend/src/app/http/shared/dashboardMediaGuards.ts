import type { RequestHandler } from "express";

import { AppError, forbidden } from "../../../shared/domain/errors.js";

/**
 * Guards for media a teammate opens from the dashboard, where every view is audited: a recording,
 * a visitor's photo. The dashboard loads them in elements (`<audio>`, `<img>`) that cannot carry
 * headers, so these stand in for what a header would have proven.
 */

/** HEAD would audit a view and send the media nowhere. `action` names what GET does ("play a recording"). */
export const refuseHeadForAuditedMedia = (action: string): RequestHandler => (req, res, next) => {
  if (req.method !== "HEAD") {
    next();
    return;
  }
  res.setHeader("Allow", "GET");
  next(new AppError(405, "method_not_allowed", `Use GET to ${action}.`));
};

/**
 * Only the dashboard's own pages may start a view: a browser names where a request came from in
 * `Sec-Fetch-Site`, so a page on another site cannot record an audited view under a teammate's
 * name. A request without it is no browser's.
 */
export const requireDashboardFetch = (refusal: string): RequestHandler => (req, _res, next) => {
  const site = req.header("sec-fetch-site");
  next(site === undefined || site === "same-origin" ? undefined : forbidden(refusal));
};
