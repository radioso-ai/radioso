import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  assertCopilotCapabilityProvenance,
  assertCopilotCapabilityProvenanceRegistry,
} from "../../../src/modules/operatorCopilot/capabilityProvenance.js";
import { enrichCopilotToolCatalog, filterCopilotToolCatalog } from "../../../src/modules/operatorCopilot/catalog.js";
import { resolveCopilotToolContributions } from "../../../src/modules/operatorCopilot/contribution.js";
import type { CopilotToolContribution } from "../../../src/modules/operatorCopilot/contribution.js";
import type { AccountPermission } from "../../../src/modules/account/public.js";
import type { CopilotToolDescriptor } from "../../../src/modules/operatorCopilot/public.js";

const descriptor = (overrides: Partial<CopilotToolDescriptor> = {}): CopilotToolDescriptor => ({
  name: "extension_tool",
  shape: "read",
  verificationCost: () => 0,
  uiLabel: "Reading extension state",
  description: "Read extension state.",
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  requiredPermissions: ["workspace.settings.read"],
  contributingModule: "extension",
  dashboardSubject: { type: "workspace_settings" },
  createTool: () => ({
    name: "extension_tool",
    description: "Read extension state.",
    inputSchema: z.object({}),
    outputSchema: z.object({ value: z.string() }),
    invoke: async () => ({ value: "extension" }),
  }),
  ...overrides,
});

const contribution = (overrides: Partial<CopilotToolContribution> = {}): CopilotToolContribution => ({
  moduleId: "radioso-enterprise-usage-limits",
  descriptors: [descriptor()],
  ...overrides,
});

const base = {
  operationIds: new Set(["listAgents", "getPlatformSettings"]),
  applicationPrimitiveIds: new Set(["agents.configuration.read"]),
};

const agentToolContext = (callId: string) => ({ signal: new AbortController().signal, stepIndex: 0, callId });

const invocationContext = (permissions: ReadonlySet<string>) => ({
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  permissions,
  currentAuthorization: {
    hasAllPermissions: async ({ requiredPermissions }: { requiredPermissions: readonly AccountPermission[] }) =>
      requiredPermissions.every((permission) => permissions.has(permission)),
  },
  pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] },
});

describe("copilot tool contributions", () => {
  it("collects descriptors, declared operations, and declared primitives from every contribution", () => {
    const resolved = resolveCopilotToolContributions([
      contribution({
        operationPermissions: { getEnterpriseUsage: ["workspace.settings.read"] },
        applicationPrimitives: { "usageLimits.account-usage.read": { owningModule: "usageLimits", exportedPort: "UsageLimitPolicy" } },
      }),
      contribution({
        moduleId: "second-extension",
        descriptors: [descriptor({ name: "second_extension_tool" })],
      }),
    ], base);

    expect(resolved.descriptors.map((entry) => entry.name)).toEqual(["extension_tool", "second_extension_tool"]);
    expect([...resolved.operationIds]).toEqual(["getEnterpriseUsage"]);
    expect([...resolved.applicationPrimitiveIds]).toEqual(["usageLimits.account-usage.read"]);
    expect(resolved.operationPermissions).toEqual({ getEnterpriseUsage: ["workspace.settings.read"] });
  });

  it("refuses a contribution that redeclares a first-party operation or primitive", () => {
    // Redeclaring an operation would let a contribution restate the permissions the parity check
    // holds a first-party descriptor to, which is the one thing the check exists to prevent.
    expect(() => resolveCopilotToolContributions([
      contribution({ operationPermissions: { listAgents: [] } }),
    ], base)).toThrow(/listAgents/);

    expect(() => resolveCopilotToolContributions([
      contribution({ applicationPrimitives: { "agents.configuration.read": { owningModule: "extension", exportedPort: "Anything" } } }),
    ], base)).toThrow(/agents.configuration.read/);
  });

  it("refuses two contributions that declare the same identity", () => {
    expect(() => resolveCopilotToolContributions([
      contribution({ operationPermissions: { getEnterpriseUsage: ["workspace.settings.read"] } }),
      contribution({
        moduleId: "second-extension",
        descriptors: [descriptor({ name: "second_extension_tool" })],
        operationPermissions: { getEnterpriseUsage: ["workspace.agents.read"] },
      }),
    ], base)).toThrow(/getEnterpriseUsage/);
  });

  it("holds a contributed descriptor to the same provenance governance as a first-party one", () => {
    const registries = { publicOperationIds: base.operationIds, applicationPrimitiveIds: base.applicationPrimitiveIds };

    expect(() => assertCopilotCapabilityProvenance([descriptor()], registries))
      .toThrow("Missing capability provenance");
    expect(() => assertCopilotCapabilityProvenance(
      [descriptor({ capabilityProvenance: { backingOperationIds: ["getEnterpriseUsage"] } })],
      registries,
    )).toThrow("Unknown public operation identity");
    expect(() => assertCopilotCapabilityProvenance(
      [descriptor({ capabilityProvenance: { applicationPrimitiveIds: ["usageLimits.account-usage.read"] } })],
      registries,
    )).toThrow("Unknown application primitive identity");
  });

  it("accepts a contributed descriptor once its own contribution declares the identity it cites", () => {
    const resolved = resolveCopilotToolContributions([
      contribution({
        descriptors: [descriptor({
          capabilityProvenance: {
            backingOperationIds: ["getEnterpriseUsage"],
            applicationPrimitiveIds: ["usageLimits.account-usage.read"],
          },
        })],
        operationPermissions: { getEnterpriseUsage: ["workspace.settings.read"] },
        applicationPrimitives: { "usageLimits.account-usage.read": { owningModule: "usageLimits", exportedPort: "UsageLimitPolicy" } },
      }),
    ], base);

    expect(() => assertCopilotCapabilityProvenance(resolved.descriptors, {
      publicOperationIds: new Set([...base.operationIds, ...resolved.operationIds]),
      operationPermissions: resolved.operationPermissions,
      ownerExportedPrimitiveIds: resolved.applicationPrimitiveIds,
      applicationPrimitiveIds: new Set([...base.applicationPrimitiveIds, ...resolved.applicationPrimitiveIds]),
    })).not.toThrow();
  });

  it("holds a contributed one-to-one descriptor to the permissions its own operation requires", () => {
    // The parity rule is the reason a contribution declares permissions at all: a tool that
    // reaches one operation must not be easier to reach through Ray than through HTTP.
    const resolved = resolveCopilotToolContributions([
      contribution({
        descriptors: [descriptor({
          requiredPermissions: ["workspace.agents.read"],
          capabilityProvenance: { backingOperationIds: ["getEnterpriseUsage"] },
        })],
        operationPermissions: { getEnterpriseUsage: ["workspace.settings.read"] },
      }),
    ], base);

    expect(() => assertCopilotCapabilityProvenance(resolved.descriptors, {
      publicOperationIds: new Set([...base.operationIds, ...resolved.operationIds]),
      operationPermissions: resolved.operationPermissions,
    })).toThrow("weakens permission parity");
  });

  it("rejects a contributed descriptor whose name collides with a first-party one", () => {
    const firstParty = descriptor({
      name: "workspace_settings",
      contributingModule: "settings",
      capabilityProvenance: { rayOnly: { reason: "A focused test descriptor." } },
    });
    const contributed = descriptor({
      name: "workspace_settings",
      capabilityProvenance: { rayOnly: { reason: "A colliding contribution." } },
    });

    expect(() => assertCopilotCapabilityProvenance([firstParty, contributed], { publicOperationIds: base.operationIds }))
      .toThrow("Duplicate copilot descriptor");
  });

  it("keeps the first-party provenance registry a bijection with first-party descriptors alone", () => {
    // The registry is reviewed OSS coverage. Running it over the merged catalog would report every
    // contributed descriptor as ungoverned and force OSS to enumerate identities it does not own.
    const firstParty = descriptor({
      name: "workspace_settings",
      contributingModule: "settings",
      capabilityProvenance: { rayOnly: { reason: "A focused test descriptor." } },
    });

    expect(() => assertCopilotCapabilityProvenanceRegistry([firstParty], {
      workspace_settings: firstParty.capabilityProvenance!,
    })).not.toThrow();
    expect(() => assertCopilotCapabilityProvenanceRegistry([firstParty, descriptor()], {
      workspace_settings: firstParty.capabilityProvenance!,
    })).toThrow("Missing copilot capability provenance");
  });

  it("filters a contributed descriptor by permission with no special case", () => {
    const catalog = [descriptor()];

    expect(filterCopilotToolCatalog(catalog, new Set<AccountPermission>(["workspace.agents.read"]))).toEqual([]);
    expect(filterCopilotToolCatalog(catalog, new Set<AccountPermission>(["workspace.settings.read"])).map((entry) => entry.name))
      .toEqual(["extension_tool"]);
  });

  it("enriches a contributed descriptor with the same dashboard handoff and authorization re-checks", async () => {
    const resolveWorkspaceKey = vi.fn(async () => "acme");
    const [enriched] = enrichCopilotToolCatalog([descriptor()], { resolveWorkspaceKey });

    const authorized = enriched!.createTool(invocationContext(new Set(["workspace.settings.read"])));
    await expect(authorized.invoke({}, agentToolContext("call-1"))).resolves.toMatchObject({
      value: "extension",
      dashboardUrl: expect.stringContaining("/w/acme"),
    });

    // A revoked permission must present as absence, exactly as it does for a first-party tool.
    const denied = enriched!.createTool(invocationContext(new Set()));
    await expect(denied.invoke({}, agentToolContext("call-2"))).resolves.toMatchObject({
      resolution: { status: "not_found" },
    });
  });
});
