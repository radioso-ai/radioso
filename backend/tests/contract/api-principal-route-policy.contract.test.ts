import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  apiPrincipalAuthenticationMode,
  apiPrincipalRouteMountPath,
  apiPrincipalRoutePolicy,
  type ApiPrincipalAuthenticationMode,
} from "../../src/app/http/apiPrincipalRoutePolicy.js";
import { createDefaultApplicationComposition } from "../../src/app/composition/defaultComposition.js";
import { createApiRouteMounts } from "../../src/app/http/routes/index.js";
import { createTestApp } from "../support/testApp.js";

type RouterLayer = {
  handle?: unknown;
  regexp?: { fast_slash?: boolean };
  fast_slash?: boolean;
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: readonly { handle?: unknown }[];
  };
};

type DiscoveredRoute = {
  key: string;
  authentication: ApiPrincipalAuthenticationMode;
};

type RouteDiscovery = {
  routes: DiscoveredRoute[];
  unregisteredNestedRouters: string[];
};

const routerLayers = (router: unknown): readonly RouterLayer[] =>
  (typeof router === "object" || typeof router === "function")
  && router !== null
  && "stack" in router
  && Array.isArray(router.stack)
    ? router.stack as RouterLayer[]
    : [];

const routeAuthentication = (layer: RouterLayer, inherited: ApiPrincipalAuthenticationMode | null) =>
  inherited ?? layer.route?.stack
    .map(({ handle }) => apiPrincipalAuthenticationMode(handle))
    .find((mode): mode is ApiPrincipalAuthenticationMode => mode !== null)
    ?? null;

const containsApiPrincipalAuthentication = (router: unknown): boolean => routerLayers(router).some((layer) =>
  apiPrincipalAuthenticationMode(layer.handle) !== null
  || layer.route?.stack.some(({ handle }) => apiPrincipalAuthenticationMode(handle) !== null)
  || containsApiPrincipalAuthentication(layer.handle));

const collectAuthenticatedRoutes = (
  router: unknown,
  mount: string,
  inheritedAuthentication: ApiPrincipalAuthenticationMode | null = null,
): RouteDiscovery => {
  const layers = routerLayers(router);
  const routerAuthentication = inheritedAuthentication ?? layers
    .map(({ handle }) => apiPrincipalAuthenticationMode(handle))
    .find((mode): mode is ApiPrincipalAuthenticationMode => mode !== null)
    ?? null;
  const discovery: RouteDiscovery = { routes: [], unregisteredNestedRouters: [] };

  for (const layer of layers) {
    if (layer.route) {
      const authentication = routeAuthentication(layer, routerAuthentication);
      if (!authentication) continue;
      const path = layer.route.path === "/" ? "" : layer.route.path;
      discovery.routes.push(...Object.entries(layer.route.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => ({
          key: `${method.toUpperCase()} ${mount}${path}`,
          authentication,
        })));
      continue;
    }

    const childLayers = routerLayers(layer.handle);
    if (childLayers.length === 0) continue;
    const childPath = apiPrincipalRouteMountPath(layer.handle)
      ?? (layer.fast_slash || layer.regexp?.fast_slash ? "" : null);
    if (childPath === null) {
      if (containsApiPrincipalAuthentication(layer.handle)) {
        discovery.unregisteredNestedRouters.push(`${mount} has an authenticated nested router without an inventory mount`);
      }
      continue;
    }
    const child = collectAuthenticatedRoutes(layer.handle, `${mount}${childPath}`, routerAuthentication);
    discovery.routes.push(...child.routes);
    discovery.unregisteredNestedRouters.push(...child.unregisteredNestedRouters);
  }

  return discovery;
};

const createRouteInventoryTestApp = () => {
  const composition = createDefaultApplicationComposition({
    logger: { error: () => undefined },
  });
  return createTestApp({ applicationRouteMounts: composition.routeMounts });
};

const discoveredAuthenticatedRoutes = (dependencies: ReturnType<typeof createTestApp>["dependencies"]): RouteDiscovery => {
  const discovery: RouteDiscovery = { routes: [], unregisteredNestedRouters: [] };
  for (const mount of [...createApiRouteMounts(dependencies), ...dependencies.applicationRouteMounts]) {
    const child = collectAuthenticatedRoutes(mount.createRouter(dependencies), mount.path);
    discovery.routes.push(...child.routes);
    discovery.unregisteredNestedRouters.push(...child.unregisteredNestedRouters);
  }
  return discovery;
};

describe("API principal route policy inventory", () => {
  it("discovers account and application-contributed authenticated routes", () => {
    const { dependencies } = createRouteInventoryTestApp();
    const keys = new Set(discoveredAuthenticatedRoutes(dependencies).routes.map(({ key }) => key));

    expect([...keys]).toEqual(expect.arrayContaining([
      "GET /api/v1/account/users",
      "GET /api/v1/account/usage-trends",
      "GET /api/v1/quality/audience-pulse",
    ]));
  });

  it("gives every mounted workspace/bearer route an explicit centralized eligibility decision", () => {
    const { dependencies } = createRouteInventoryTestApp();
    const discovery = discoveredAuthenticatedRoutes(dependencies);
    const { routes } = discovery;
    expect(routes.length).toBeGreaterThan(50);
    expect(discovery.unregisteredNestedRouters).toEqual([]);

    const omissions: string[] = [];
    for (const { key, authentication } of routes) {
      const eligibility = apiPrincipalRoutePolicy[key];
      if (!eligibility) {
        omissions.push(`${key} is mounted but has no API principal policy`);
        continue;
      }
      expect(eligibility?.permission, `${key} must name its centralized permission`).toBeTruthy();
      expect(eligibility?.allowedPrincipalKinds.length, `${key} must name allowed principal kinds`).toBeGreaterThan(0);
      expect(typeof eligibility?.sessionOnly, `${key} must state session-only status`).toBe("boolean");
      if (authentication === "session_only") {
        expect(eligibility?.sessionOnly, `${key} must remain session-only`).toBe(true);
      }
      if (authentication === "machine_required") {
        expect(eligibility?.sessionOnly, `${key} must admit its required bearer principal`).toBe(false);
      }
    }
    expect(omissions).toEqual([]);
  });

  it("checks the inventory against the actual authenticated public mounts", async () => {
    const { app, dependencies } = createRouteInventoryTestApp();
    const mountedPaths = new Set([
      ...createApiRouteMounts(dependencies).map((mount) => mount.path),
      ...dependencies.applicationRouteMounts.map((mount) => mount.path),
    ]);
    const concretePath = (path: string) => path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, "11111111-1111-1111-1111-111111111111");

    for (const { key } of discoveredAuthenticatedRoutes(dependencies).routes.filter(({ key }) => {
      const path = key.slice(key.indexOf(" ") + 1);
      return [...mountedPaths].some((mount) => path === mount || path.startsWith(`${mount}/`));
    })) {
      const separator = key.indexOf(" ");
      const method = key.slice(0, separator).toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
      const path = concretePath(key.slice(separator + 1));
      const response = await request(app)[method](path);
      expect(response.status, `${key} must remain mounted behind authenticated access`).toBe(401);
    }
  });
});
