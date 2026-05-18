import { describe, expect, it } from "vitest";

import {
  collectFrontendRouteContributions,
  validateFeatureManifests,
  type FeatureManifest,
} from "./featureManifest.js";

const baseManifest = (overrides: Partial<FeatureManifest> = {}): FeatureManifest => ({
  id: "enterprise-agent-wizard",
  name: "Enterprise Agent Wizard",
  edition: "enterprise",
  backendModuleId: "radioso-enterprise-agent-wizard",
  apiNamespaces: ["/api/v1/ee/agent-wizard"],
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
      baseManifest({ name: "Duplicate Enterprise Agent Wizard" }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Duplicate feature id "enterprise-agent-wizard"');
  });

  it("rejects duplicate frontend route ownership", () => {
    const frontendRoutes = [{
      relativePath: "app/agents/wizard/page.tsx",
      packageName: "@radioso/enterprise-agent-wizard-frontend",
      exportPath: "wizard-page",
      exports: ["default"],
    }];

    const result = validateFeatureManifests([
      baseManifest({ frontendRoutes }),
      baseManifest({
        id: "other-agent-wizard",
        name: "Other Agent Wizard",
        frontendRoutes,
      }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Frontend route "app/agents/wizard/page.tsx" is owned by multiple features',
    );
  });

  it("rejects frontend routes missing required package or export fields", () => {
    const result = validateFeatureManifests([
      baseManifest({
        frontendRoutes: [
          {
            relativePath: "app/agents/wizard/page.tsx",
            exportPath: "wizard-page",
            exports: ["default"],
          } as any,
          {
            relativePath: "app/agents/wizard/settings/page.tsx",
            packageName: "@radioso/enterprise-agent-wizard-frontend",
            exports: ["default"],
          } as any,
        ],
      }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Enterprise feature "enterprise-agent-wizard" route "app/agents/wizard/page.tsx" must declare packageName',
    );
    expect(result.errors).toContain(
      'Feature "enterprise-agent-wizard" route "app/agents/wizard/settings/page.tsx" must declare exportPath',
    );
  });

  it("rejects missing referenced documentation", () => {
    const result = validateFeatureManifests([
      baseManifest({ docs: ["ee/missing.md"] }),
    ], {
      existingDocs: new Set(["ee/readme.md"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Feature "enterprise-agent-wizard" references missing doc "ee/missing.md"');
  });

  it("collects frontend route contributions in feature order", () => {
    const route = {
      relativePath: "app/agents/wizard/page.tsx",
      packageName: "@radioso/enterprise-agent-wizard-frontend",
      exportPath: "wizard-page",
      exports: ["default"],
    };

    expect(collectFrontendRouteContributions([
      baseManifest({ frontendRoutes: [route] }),
    ])).toEqual([route]);
  });
});
