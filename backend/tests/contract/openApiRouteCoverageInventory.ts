import { apiPrincipalRouteMountPath } from "../../src/app/http/apiPrincipalRoutePolicy.js";

/**
 * Structural view of an Express router layer (Express does not export these internals). The
 * single owner of this shape and the walk below; `api-principal-route-policy.contract.test.ts`
 * imports both rather than declaring its own copy. `route.stack` — the per-route middleware
 * stack — is optional because this module's own walk never reads it; only the route-policy
 * test, which inspects middleware to find the api-principal-auth layer, does.
 */
export type RouterLayer = {
  handle?: unknown;
  regexp?: { fast_slash?: boolean };
  fast_slash?: boolean;
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack?: readonly { handle?: unknown }[];
  };
};

export const routerLayers = (router: unknown): readonly RouterLayer[] =>
  (typeof router === "object" || typeof router === "function")
  && router !== null
  && "stack" in router
  && Array.isArray(router.stack)
    ? router.stack as RouterLayer[]
    : [];

export type MountedRoute = {
  readonly method: string;
  readonly path: string;
};

type RouteDiscovery = {
  readonly routes: readonly MountedRoute[];
  /** A nested router mounted at a literal sub-path without `markApiPrincipalRouteMount`, so its mount point — and therefore its routes — cannot be recovered structurally. */
  readonly unidentifiedNestedRouters: readonly string[];
};

/**
 * Walks an Express router's layer stack to enumerate every mounted (METHOD, path) pair,
 * recursing into nested routers. This mirrors the structural walk in
 * `api-principal-route-policy.contract.test.ts`, but collects every route rather than only
 * authenticated ones: OpenAPI coverage must see public routes (health checks, OAuth callbacks,
 * webhooks) too, not just the ones behind a principal.
 *
 * A nested router mounted with a literal sub-path (anything other than the router's own root)
 * must mark its mount point with `markApiPrincipalRouteMount` for this walk to find it — the
 * same convention the route-policy inventory relies on. An unmarked nested router is reported in
 * `unidentifiedNestedRouters` rather than silently dropped, so a future nested mount cannot
 * quietly escape coverage.
 */
export const collectMountedRoutes = (router: unknown, mount: string): RouteDiscovery => {
  const routes: MountedRoute[] = [];
  const unidentifiedNestedRouters: string[] = [];

  for (const layer of routerLayers(router)) {
    if (layer.route) {
      const path = layer.route.path === "/" ? "" : layer.route.path;
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled) routes.push({ method: method.toUpperCase(), path: `${mount}${path}` });
      }
      continue;
    }

    const childLayers = routerLayers(layer.handle);
    if (childLayers.length === 0) continue;

    const childPath = apiPrincipalRouteMountPath(layer.handle)
      ?? (layer.fast_slash || layer.regexp?.fast_slash ? "" : null);
    if (childPath === null) {
      unidentifiedNestedRouters.push(`${mount} has a nested router without an identifiable mount path`);
      continue;
    }

    const child = collectMountedRoutes(layer.handle, `${mount}${childPath}`);
    routes.push(...child.routes);
    unidentifiedNestedRouters.push(...child.unidentifiedNestedRouters);
  }

  return { routes, unidentifiedNestedRouters };
};

/**
 * A path segment that names a dynamic parameter, in either Express (`:id`) or OpenAPI (`{id}`)
 * form. The two sides are free to spell the same parameter differently (`:documentId` vs.
 * `{documentId}`, or just a different name entirely), so coverage compares path *shape* — this
 * collapses both forms to one placeholder — rather than the literal parameter name.
 */
const PARAM_SEGMENT = /:[A-Za-z0-9_]+|\{[A-Za-z0-9_]+\}/g;

const normalizePathShape = (path: string): string => path.replace(PARAM_SEGMENT, "{param}");

/** A comparable key for a (method, path) pair, shape-normalized so Express and OpenAPI params compare equal regardless of their names. */
export const routeKey = (method: string, path: string): string => `${method.toUpperCase()} ${normalizePathShape(path)}`;

/** Parses a `"METHOD /path"` table key (as written in an exclusion table) into the same normalized key `routeKey` produces. */
export const normalizeRouteKey = (rawKey: string): string => {
  const separatorIndex = rawKey.indexOf(" ");
  if (separatorIndex === -1) throw new Error(`Route table key "${rawKey}" is missing its method/path separator`);
  return routeKey(rawKey.slice(0, separatorIndex), rawKey.slice(separatorIndex + 1));
};

/** Whether `path` falls under any of `prefixes` — an exact segment match, not a string-prefix match (`/api/v11` does not match `/api/v1`). */
export const pathStartsWithPrefix = (path: string, prefixes: ReadonlySet<string>): boolean =>
  [...prefixes].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
