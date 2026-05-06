import { describe, expect, it } from "vitest";

import {
  collectFrontendRouteContributions,
  validateFeatureManifests,
  type FeatureManifest,
} from "./featureManifest.js";

const baseManifest = (overrides: Partial<FeatureManifest> = {}): FeatureManifest => ({
  id: "enterprise-auth",
  name: "Enterprise Auth",
  edition: "enterprise",
  backendModuleId: "radioso-enterprise-auth",
  apiNamespaces: ["/api/v1/ee/auth"],
  docs: ["ee/readme.md"],
  ...overrides,
});

describe("feature manifests", () => {
  it("accepts unique feature ownership metadata", () => {
    const result = validateFeatureManifests([
      baseManifest(),
      baseManifest({
        id: "enterprise-embed-widget",
        name: "Enterprise Embed Widget",
        backendModuleId: undefined,
        apiNamespaces: undefined,
        frontendRoutes: [
          {
            relativePath: "app/embed/[token]/page.tsx",
            packageName: "@radioso/enterprise-embed-widget",
            exportPath: "embed-page",
            exports: ["default"],
          },
        ],
      }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rejects duplicate feature identifiers", () => {
    const result = validateFeatureManifests([
      baseManifest(),
      baseManifest({ name: "Duplicate Enterprise Auth" }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Duplicate feature id "enterprise-auth"');
  });

  it("rejects duplicate frontend route ownership", () => {
    const frontendRoutes = [{
      relativePath: "app/reset-password/page.tsx",
      packageName: "@radioso/enterprise-auth-frontend",
      exportPath: "reset-password-page",
      exports: ["default"],
    }];

    const result = validateFeatureManifests([
      baseManifest({ frontendRoutes }),
      baseManifest({
        id: "other-auth",
        name: "Other Auth",
        frontendRoutes,
      }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Frontend route "app/reset-password/page.tsx" is owned by multiple features',
    );
  });

  it("rejects missing referenced documentation", () => {
    const result = validateFeatureManifests([
      baseManifest({ docs: ["ee/missing.md"] }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Feature "enterprise-auth" references missing doc "ee/missing.md"');
  });

  it("collects frontend route contributions in feature order", () => {
    const route = {
      relativePath: "app/verify-email/page.tsx",
      packageName: "@radioso/enterprise-auth-frontend",
      exportPath: "verify-email-page",
      exports: ["default"],
    };

    expect(collectFrontendRouteContributions([
      baseManifest({ frontendRoutes: [route] }),
    ])).toEqual([route]);
  });
});
