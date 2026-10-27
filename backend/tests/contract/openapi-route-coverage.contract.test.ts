import { beforeAll, describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { createDefaultApplicationComposition } from "../../src/app/composition/defaultComposition.js";
import { createApiRouteMounts } from "../../src/app/http/routes/index.js";
import { createTestApp } from "../support/testApp.js";
import {
  collectMountedRoutes,
  normalizeRouteKey,
  pathStartsWithPrefix,
  routeKey,
  type MountedRoute,
} from "./openApiRouteCoverageInventory.js";

/**
 * The OpenAPI document (`createOpenApiDocument`) feeds the committed TypeScript SDK snapshot,
 * the MCP server's generated types, and the operator-copilot coverage map
 * (`tests/unit/operatorCopilot/catalogCoverage.ts`, keyed by operationId). A route mounted on the
 * app but missing from OpenAPI silently escapes all three. This gate enumerates every route
 * actually mounted — the way `api-principal-route-policy.contract.test.ts` does, by building the
 * real app and walking its router stacks — and checks it against the OpenAPI document, in both
 * directions.
 *
 * Every mounted route is in scope unless it falls under `outOfScopeMountPrefixes` below. There is
 * no "derive scope from what OpenAPI already documents" step — that would let a route mounted
 * under a brand-new, never-documented prefix escape the gate entirely, which defeats the gate's
 * purpose.
 *
 * Nothing here regenerates OpenAPI or the SDK: a route found missing goes in
 * `undocumentedRouteExclusions` with a specific reason, not into the registry.
 */

type OpenApiDocument = ReturnType<typeof createOpenApiDocument>;

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

/**
 * Every mounted route with no matching OpenAPI operation, grouped by why it is exempt. A new
 * mounted route that matches none of these keys fails the first test below until it is either
 * registered in the OpenAPI registry or added here with a specific, verified reason —
 * "legacy" or "for now" do not qualify.
 */
const undocumentedRouteExclusions: Record<string, string> = {
  // --- Email link landing pages. RFC 8058 one-click confirm/unsubscribe/resume links clicked
  // from an email client. A signed, single-use query-string token authenticates them and they
  // render an HTML form page, not JSON, so they are not an SDK/MCP operation.
  "GET /api/v1/notification-recipient-confirmations/confirm": "email link landing page (RFC 8058 confirm), renders HTML, authenticates via a signed single-use token in the query string",
  "POST /api/v1/notification-recipient-confirmations/confirm": "email link landing page (RFC 8058 confirm), renders HTML, authenticates via a signed single-use token in the query string",
  "GET /api/v1/notification-recipient-confirmations/revoke": "email link landing page (RFC 8058 one-click unsubscribe), renders HTML, authenticates via a signed single-use token in the query string",
  "POST /api/v1/notification-recipient-confirmations/revoke": "email link landing page (RFC 8058 one-click unsubscribe), renders HTML, authenticates via a signed single-use token in the query string",
  "POST /api/v1/notification-recipient-confirmations/resume": "email link landing page (resume after unsubscribe), renders HTML, authenticates via a signed single-use token in the query string",

  // --- OAuth protocol endpoints. RFC 8414 discovery metadata and the authorize/token/revoke
  // lifecycle are consumed by generic OAuth clients per the OAuth specs' own request/response
  // shapes, not modeled as Radioso SDK operations.
  "GET /.well-known/oauth-authorization-server": "OAuth protocol: RFC 8414 authorization server metadata discovery document",
  "GET /api/v1/operator-mcp/oauth/authorize": "OAuth protocol: authorization endpoint, browser redirect flow",
  "POST /api/v1/operator-mcp/oauth/token": "OAuth protocol: token endpoint, RFC 6749 request/response shape",
  "POST /api/v1/operator-mcp/oauth/revoke": "OAuth protocol: RFC 7009 token revocation endpoint",

  // --- Internal service-to-service RPC. Signed calls between the backend and the standalone
  // operator-copilot MCP process, authenticated with an internal shared secret or the MCP source
  // proof; never reachable with an operator session or an issued API credential.
  "POST /api/v1/internal/operator-copilot/mcp/admissions": "internal service RPC between the backend and the standalone operator-copilot MCP process, HMAC service-auth only (see operatorCopilot/mcpRoutes.ts)",
  "POST /api/v1/internal/operator-copilot/mcp/catalog": "internal service RPC between the backend and the standalone operator-copilot MCP process, HMAC service-auth only (see operatorCopilot/mcpRoutes.ts)",
  "POST /api/v1/internal/operator-copilot/mcp/invocations": "internal service RPC between the backend and the standalone operator-copilot MCP process, HMAC service-auth only (see operatorCopilot/mcpRoutes.ts)",
  "POST /api/v1/mcp/converse/session/use": "internal MCP edge liveness signal; requires the signed MCP source proof only the first-party MCP server package can produce",

  // --- Voice vendor callback. Shaped to the OpenAI chat-completions wire protocol because the
  // voice vendor's pipeline calls this mid-call as its LLM backend; it is not Radioso's own API
  // contract and is never called by the SDK, MCP, or dashboard.
  "POST /api/v1/agents/{param}/voice/{param}/v1/chat/completions": "voice vendor callback, OpenAI-compatible chat-completions wire shape, not a Radioso API operation",

  // --- Frontend telemetry beacons. The first-party frontend/embed self-reports its own errors
  // and UX analytics events here; this is ingestion for Radioso's own client code, not a product
  // API operation for an external caller.
  "POST /api/v1/observability/frontend-errors": "frontend telemetry beacon, first-party browser self-reporting only",
  "POST /api/v1/observability/product-analytics": "frontend telemetry beacon, first-party browser self-reporting only",
};

/**
 * Mount prefixes that sit outside the API contract altogether, not just a single undocumented
 * route under a documented one — so a route under one of these is never checked against OpenAPI
 * or the exclusion table above. Every entry must match at least one mounted route; one that
 * matches nothing is exempting a route that no longer exists and must be retired.
 */
const outOfScopeMountPrefixes: Record<string, string> = {
  "/api/connectors": "connector webhook and dynamically-registered connector-plugin callback routes (e.g. the email delivery webhook, and per-connector routes plugins mount at runtime keyed by connector id); not Radioso API operations and not enumerable as fixed OpenAPI paths",
};

/**
 * OpenAPI operations with no mounted route in the app this test builds. A documented path with
 * no backing route would publish a lie in the generated SDK, so this table stays empty unless an
 * entry names a specific, verified reason — including, when relevant, exactly where the route
 * actually lives.
 */
const reverseRouteMismatches: Record<string, string> = {
  "GET /api/v1/events": "the documented dashboard SSE stream (operationId streamWorkspaceEvents) is mounted on the separate realtime server process (src/runtime/realtimeServer.ts), not the main Express app this test builds",
};

const buildMountedRouteInventory = (): { routes: readonly MountedRoute[]; unidentifiedNestedRouters: readonly string[] } => {
  const composition = createDefaultApplicationComposition({ logger: { error: () => undefined } });
  const { dependencies } = createTestApp({ applicationRouteMounts: composition.routeMounts });

  const routes: MountedRoute[] = [{ method: "GET", path: "/health" }];
  const unidentifiedNestedRouters: string[] = [];
  for (const mount of [...createApiRouteMounts(dependencies), ...dependencies.applicationRouteMounts]) {
    const child = collectMountedRoutes(mount.createRouter(dependencies), mount.path);
    routes.push(...child.routes);
    unidentifiedNestedRouters.push(...child.unidentifiedNestedRouters);
  }
  return { routes, unidentifiedNestedRouters };
};

const documentedRouteKeys = (document: OpenApiDocument): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    if (!operations) continue;
    for (const method of Object.keys(operations)) {
      if (HTTP_METHODS.has(method)) keys.add(routeKey(method, path));
    }
  }
  return keys;
};

describe("OpenAPI route coverage", () => {
  // Built once and shared: both tests below need the same composition, test app, route
  // inventory, and OpenAPI document, and building each a second time is pure waste.
  let document: OpenApiDocument;
  let routes: readonly MountedRoute[];
  let unidentifiedNestedRouters: readonly string[];
  let inScopeRoutes: readonly MountedRoute[];

  beforeAll(() => {
    document = createOpenApiDocument();
    const inventory = buildMountedRouteInventory();
    routes = inventory.routes;
    unidentifiedNestedRouters = inventory.unidentifiedNestedRouters;
    const outOfScopePrefixes = new Set(Object.keys(outOfScopeMountPrefixes));
    inScopeRoutes = routes.filter((route) => !pathStartsWithPrefix(route.path, outOfScopePrefixes));
  });

  it("documents, or explicitly and specifically excludes, every mounted route", () => {
    // A nested router this walk cannot place structurally would silently vanish from coverage,
    // so treat it the same as a coverage failure rather than skipping past it.
    expect(unidentifiedNestedRouters).toEqual([]);
    expect(routes.length).toBeGreaterThan(300);

    const documented = documentedRouteKeys(document);
    const exclusionKeys = new Set(Object.keys(undocumentedRouteExclusions).map(normalizeRouteKey));
    expect(exclusionKeys.size).toBe(Object.keys(undocumentedRouteExclusions).length);

    const inScopeKeys = new Set<string>();
    const undocumentedUnexcused: string[] = [];
    const documentedAndExcluded: string[] = [];

    for (const route of inScopeRoutes) {
      const key = routeKey(route.method, route.path);
      inScopeKeys.add(key);

      const isDocumented = documented.has(key);
      const isExcluded = exclusionKeys.has(key);
      if (isDocumented && isExcluded) documentedAndExcluded.push(`${key} is documented in OpenAPI and still listed as an exclusion`);
      if (!isDocumented && !isExcluded) undocumentedUnexcused.push(`${key} (mounted as ${route.method} ${route.path}) has no OpenAPI operation and no exclusion entry`);
    }

    expect(documentedAndExcluded).toEqual([]);
    expect(undocumentedUnexcused).toEqual([]);

    // A stale exclusion (its route renamed, removed, or already documented) must not sit there
    // ready to quietly re-exempt a future, unrelated route that happens to normalize to the
    // same key.
    const staleExclusions = [...exclusionKeys].filter((key) => !inScopeKeys.has(key));
    expect(staleExclusions).toEqual([]);

    // Same contract for the out-of-scope table itself: an entry matching no mounted route is
    // exempting a route that no longer exists.
    const staleOutOfScopePrefixes = Object.keys(outOfScopeMountPrefixes).filter(
      (prefix) => !routes.some((route) => pathStartsWithPrefix(route.path, new Set([prefix]))),
    );
    expect(staleOutOfScopePrefixes).toEqual([]);
  });

  it("keeps the reverse table honest: every OpenAPI operation either has a mounted route or a specific, named exclusion", () => {
    const mountedKeysInScope = new Set(inScopeRoutes.map((route) => routeKey(route.method, route.path)));

    const reverseMismatchKeys = new Set(Object.keys(reverseRouteMismatches).map(normalizeRouteKey));
    expect(reverseMismatchKeys.size).toBe(Object.keys(reverseRouteMismatches).length);

    const unmountedUnexcused: string[] = [];
    const mountedAndExcused: string[] = [];

    for (const [path, operations] of Object.entries(document.paths ?? {})) {
      if (!operations) continue;
      for (const method of Object.keys(operations)) {
        if (!HTTP_METHODS.has(method)) continue;
        const key = routeKey(method, path);
        const isMounted = mountedKeysInScope.has(key);
        const isExcused = reverseMismatchKeys.has(key);
        if (isMounted && isExcused) mountedAndExcused.push(`${key} is mounted and still listed as a reverse mismatch`);
        if (!isMounted && !isExcused) unmountedUnexcused.push(`${key} (documented as ${method.toUpperCase()} ${path}) has no mounted route and no reverse-mismatch entry`);
      }
    }

    expect(mountedAndExcused).toEqual([]);
    expect(unmountedUnexcused).toEqual([]);

    // A reverse-mismatch entry for an operation that has since been removed from the document
    // is exempting nothing; it must be retired along with the operation it described.
    const documented = documentedRouteKeys(document);
    const staleReverseMismatches = [...reverseMismatchKeys].filter((key) => !documented.has(key));
    expect(staleReverseMismatches).toEqual([]);
  });
});
