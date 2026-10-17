import type { RequestHandler } from "express";

import { WORKSPACE_HEADER } from "./requireWorkspaceSession.js";

/**
 * The dashboard reads some media straight into an element (`<img>`, `<audio>`), which cannot carry
 * the workspace header. Such a read accepts the workspace as a `workspaceId` query selector, and the
 * session middleware checks it against the caller's account exactly as it does the header: the
 * query carries a selection, never an authorisation.
 */
export const acceptWorkspaceIdFromQuery: RequestHandler = (req, _res, next) => {
  const selected = req.query.workspaceId;
  if (typeof selected === "string" && !req.header(WORKSPACE_HEADER)) {
    req.headers[WORKSPACE_HEADER.toLowerCase()] = selected;
  }
  next();
};
