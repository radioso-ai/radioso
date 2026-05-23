import { describe, expect, it } from "vitest";

import {
  collectFrontendRouteContributions,
  validateFeatureManifests,
  type FeatureManifest,
} from "./featureManifest.js";

const baseManifest = (overrides: Partial<FeatureManifest> = {}): FeatureManifest => ({
  id: "enterprise-sample-feature",
  name: "Enterprise Sample Feature",
  edition: "enterprise",
  backendModuleId: "radioso-enterprise-sample-feature",
  apiNamespaces: ["/api/v1/ee/sample"],
  docs: ["ee/readme.md"],
  ...overrides,
});

describe("feature manifests", () => {
  it("accepts unique feature ownership metadata", () => {
    const result = validateFeatureManifests([
      baseManifest(),
      baseManifest({
        id: "enterprise-sample-frontend",
        name: "Enterprise Sample Frontend",
        backendModuleId: undefined,
        apiNamespaces: undefined,
        frontendRoutes: [
          {
            relativePath: "app/sample/page.tsx",
            packageName: "@radioso/enterprise-sample-frontend",
            exportPath: "sample-page",
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
      baseManifest({ name: "Duplicate Enterprise Sample Feature" }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Duplicate feature id "enterprise-sample-feature"');
  });

  it("rejects duplicate frontend route ownership", () => {
    const frontendRoutes = [{
      relativePath: "app/sample/page.tsx",
      packageName: "@radioso/enterprise-sample-frontend",
      exportPath: "sample-page",
      exports: ["default"],
    }];

    const result = validateFeatureManifests([
      baseManifest({ frontendRoutes }),
      baseManifest({
        id: "other-sample-feature",
        name: "Other Sample Feature",
        frontendRoutes,
      }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Frontend route "app/sample/page.tsx" is owned by multiple features',
    );
  });

  it("rejects frontend routes missing required package or export fields", () => {
    const result = validateFeatureManifests([
      baseManifest({
        frontendRoutes: [
          {
            relativePath: "app/sample/page.tsx",
            exportPath: "sample-page",
            exports: ["default"],
          } as any,
          {
            relativePath: "app/sample/settings/page.tsx",
            packageName: "@radioso/enterprise-sample-frontend",
            exports: ["default"],
          } as any,
        ],
      }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Enterprise feature "enterprise-sample-feature" route "app/sample/page.tsx" must declare packageName',
    );
    expect(result.errors).toContain(
      'Feature "enterprise-sample-feature" route "app/sample/settings/page.tsx" must declare exportPath',
    );
  });

  it("rejects missing referenced documentation", () => {
    const result = validateFeatureManifests([
      baseManifest({ docs: ["ee/missing.md"] }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Feature "enterprise-sample-feature" references missing doc "ee/missing.md"');
  });

  it("collects frontend route contributions in feature order", () => {
    const route = {
      relativePath: "app/sample/page.tsx",
      packageName: "@radioso/enterprise-sample-frontend",
      exportPath: "sample-page",
      exports: ["default"],
    };

    expect(collectFrontendRouteContributions([
      baseManifest({ frontendRoutes: [route] }),
    ])).toEqual([route]);
  });
});
