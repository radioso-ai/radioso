import type { RequestHandler } from "express";

/**
 * The route pattern a request matched — `/api/v1/auth/invitations/:token`, never the resolved
 * `/api/v1/auth/invitations/3f9c…` — so the request line, the error report, telemetry and traces
 * can name a request without the credential or the words a path segment can carry (an invitation
 * token, a public chat token).
 *
 * Express names the match only through `req.route` and `req.baseUrl`, and `req.baseUrl` does not
 * hold still: a sub-router restores its parent's as an error leaves it through `next(err)`, so by
 * the time the error handler or the finished response reads it, the mount prefix is gone. Express
 * assigns `req.route` at the moment it dispatches to a route, while `req.baseUrl` is still the
 * mount the route matched under, so the recorder captures the pattern then.
 *
 * A parameter mount (`/:workspaceId/webhook`, `connectorRegistry.ts`) resolves into `req.baseUrl`
 * too. Its router uses `mergeParams`, so the value reaches `req.params`, and the recorder puts the
 * parameter's name back in the segment that holds it. A request no route matched — a 404, or a
 * 401 or 429 a middleware sent first — records no pattern, and nothing falls back to the raw path.
 */
const MATCHED_ROUTE = Symbol("radioso.matchedRoute");

// Every pattern recorded so far. Patterns are route definitions, so the set stays as small as the
// route table; the cap only bounds it if something unexpected resolves into a pattern.
const MAX_REMEMBERED_PATTERNS = 4096;
const rememberedPatterns = new Set<string>();

type RouteCarrier = { [MATCHED_ROUTE]?: string };

const ROUTE_PARAMETER_PATTERN = /:(\w+)/gu;

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

// Express keeps a route's own parameters in its path; any other entry of `req.params` came from a
// mount, so the mount segment holding that value is named by the parameter instead.
const mountPatternOf = (baseUrl: string, routePath: string, params: unknown): string => {
  const routeParameters = new Set([...routePath.matchAll(ROUTE_PARAMETER_PATTERN)].map((match) => match[1]));
  const mountParameters = Object.entries(typeof params === "object" && params !== null ? params : {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && !routeParameters.has(entry[0]));
  if (mountParameters.length === 0) {
    return baseUrl;
  }
  return baseUrl
    .split("/")
    .map((segment) => {
      const value = decodeSegment(segment);
      const parameter = mountParameters.find((entry) => entry[1] === value);
      return parameter ? `:${parameter[0]}` : segment;
    })
    .join("/");
};

const patternOf = (req: { baseUrl?: unknown; params?: unknown }, route: unknown): string | undefined => {
  const path = typeof route === "object" && route !== null ? (route as { path?: unknown }).path : undefined;
  if (typeof path !== "string") {
    return undefined;
  }
  const baseUrl = typeof req.baseUrl === "string" ? req.baseUrl : "";
  return `${mountPatternOf(baseUrl, path, req.params)}${path}`;
};

/** Installed before any router, so every route Express dispatches to is recorded as it matches. */
export const createMatchedRouteRecorder = (): RequestHandler => (req, _res, next) => {
  let route: unknown = req.route;
  Object.defineProperty(req, "route", {
    configurable: true,
    enumerable: true,
    get: () => route,
    set: (value: unknown) => {
      route = value;
      const pattern = patternOf(req, value);
      (req as RouteCarrier)[MATCHED_ROUTE] = pattern;
      if (pattern && rememberedPatterns.size < MAX_REMEMBERED_PATTERNS) {
        rememberedPatterns.add(pattern);
      }
    },
  });
  next();
};

export const matchedRoutePattern = (req: object): string | undefined => {
  const pattern = (req as RouteCarrier)[MATCHED_ROUTE];
  return typeof pattern === "string" ? pattern : undefined;
};

/**
 * Whether a string is a route pattern this process recorded a request matching, so a `route`
 * field read off a log call's arguments can be trusted to be a pattern rather than a raw path
 * (`logging/index.ts`).
 */
export const isRecordedRoutePattern = (value: string): boolean => rememberedPatterns.has(value);
