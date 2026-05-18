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
        id: "enterprise-agent-wizard",
        name: "Enterprise Agent Wizard",
        backendModuleId: undefined,
        apiNamespaces: undefined,
        frontendRoutes: [
          {
            relativePath: "app/agents/wizard/page.tsx",
            packageName: "@radioso/enterprise-agent-wizard-frontend",
            exportPath: "wizard-page",
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

  it("rejects frontend routes missing required package or export fields", () => {
    const result = validateFeatureManifests([
      baseManifest({
        frontendRoutes: [
          {
            relativePath: "app/reset-password/page.tsx",
            exportPath: "reset-password-page",
            exports: ["default"],
          } as any,
          {
            relativePath: "app/verify-email/page.tsx",
            packageName: "@radioso/enterprise-auth-frontend",
            exports: ["default"],
          } as any,
        ],
      }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Enterprise feature "enterprise-auth" route "app/reset-password/page.tsx" must declare packageName',
    );
    expect(result.errors).toContain(
      'Feature "enterprise-auth" route "app/verify-email/page.tsx" must declare exportPath',
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
