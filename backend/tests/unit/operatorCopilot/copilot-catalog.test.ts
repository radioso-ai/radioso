import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  filterCopilotToolCatalog,
  enrichCopilotToolCatalog,
  type CopilotToolDescriptor,
} from "../../../src/modules/operatorCopilot/public.js";
import {
  assertCopilotCapabilityProvenance,
  assertCopilotCapabilityProvenanceRegistry,
  copilotCapabilityProvenance,
} from "../../../src/modules/operatorCopilot/capabilityProvenance.js";
import { copilotApplicationPrimitiveRegistry } from "../../../src/modules/operatorCopilot/applicationPrimitiveRegistry.js";

const descriptor = (...permissions: CopilotToolDescriptor["requiredPermissions"]): CopilotToolDescriptor => ({
  name: `tool_${permissions.join("_").replaceAll(".", "_")}`,
  shape: "read",
  uiLabel: "Safe tool label",
  description: "A focused read-only operator capability.",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  requiredPermissions: permissions,
  contributingModule: "test",
  dashboardSubject: { type: "workspace" },
  createTool: () => ({
    name: "test",
    description: "test",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    invoke: async () => ({}),
  }),
});

describe("filterCopilotToolCatalog", () => {
  it("only exposes descriptors for permissions held by the session principal", () => {
    const catalog = filterCopilotToolCatalog(
      [descriptor("workspace.agents.read"), descriptor("workspace.history.read")],
      new Set(["workspace.agents.read"]),
    );

    expect(catalog.map((tool) => tool.requiredPermissions)).toEqual([["workspace.agents.read"]]);
  });

  it("requires every declared permission before exposing a descriptor", () => {
    const probe = descriptor(
      "workspace.agents.read",
      "workspace.chat.use",
      "workspace.history.read",
      "workspace.agents.manage",
    );

    for (const missing of probe.requiredPermissions) {
      const granted = new Set(probe.requiredPermissions.filter((permission) => permission !== missing));
      expect(filterCopilotToolCatalog([probe], granted)).toEqual([]);
    }
    expect(filterCopilotToolCatalog([probe], new Set(probe.requiredPermissions))).toEqual([probe]);
  });

  it("recognizes every read permission in the initial catalog matrix", () => {
    const catalog = filterCopilotToolCatalog(
      [
        descriptor("workspace.agents.read"),
        descriptor("workspace.history.read"),
        descriptor("workspace.documents.read"),
        descriptor("workspace.retrieval.query"),
        descriptor("workspace.quality.read"),
      ],
      new Set(["workspace.retrieval.query", "workspace.quality.read"]),
    );

    expect(catalog.map((tool) => tool.requiredPermissions)).toEqual([
      ["workspace.retrieval.query"],
      ["workspace.quality.read"],
    ]);
  });
});

describe("enrichCopilotToolCatalog current authorization", () => {
  it("reauthorizes before entity resolution and again before invocation", async () => {
    const describeEntity = vi.fn(async () => ({
      kind: "ambiguous" as const,
      candidates: [{ type: "agent", id: "agent-1", label: "Sensitive agent" }],
    }));
    const invoke = vi.fn(async () => ({ value: "safe" }));
    const authorization = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const [enriched] = enrichCopilotToolCatalog([{
      ...descriptor("workspace.agents.read"),
      outputSchema: z.object({ value: z.string() }),
      describeEntity,
      createTool: () => ({
        name: "current_reader",
        description: "current reader",
        inputSchema: z.object({}),
        outputSchema: z.object({ value: z.string() }),
        invoke,
      }),
    }], { resolveWorkspaceKey: async () => "workspace" });
    const tool = enriched?.createTool({
      workspaceId: "workspace",
      accountId: "account",
      operatorUserId: "operator",
      permissions: new Set(["workspace.agents.read"]),
      currentAuthorization: { hasAllPermissions: authorization },
      pageContext: { view: "other", agentId: null, conversationId: null, selection: null, entities: [] },
    });

    await expect(tool?.invoke({}, {} as never)).resolves.toMatchObject({ resolution: { status: "not_found" } });
    expect(describeEntity).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();

    await expect(tool?.invoke({}, {} as never)).resolves.toMatchObject({ resolution: { status: "not_found" } });
    expect(describeEntity).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(authorization).toHaveBeenCalledTimes(3);
  });

  it("withholds a protected tool result when authority is revoked while it reads", async () => {
    const invoke = vi.fn(async () => ({ value: "sensitive result" }));
    const authorization = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const [enriched] = enrichCopilotToolCatalog([{
      ...descriptor("workspace.agents.read"),
      outputSchema: z.object({ value: z.string() }),
      createTool: () => ({
        name: "current_reader",
        description: "current reader",
        inputSchema: z.object({}),
        outputSchema: z.object({ value: z.string() }),
        invoke,
      }),
    }], { resolveWorkspaceKey: async () => "workspace" });
    const tool = enriched?.createTool({
      workspaceId: "workspace",
      accountId: "account",
      operatorUserId: "operator",
      currentAuthorization: { hasAllPermissions: authorization },
      pageContext: { view: "other", agentId: null, conversationId: null, selection: null, entities: [] },
    });

    await expect(tool?.invoke({}, {} as never)).resolves.toMatchObject({ resolution: { status: "not_found" } });
    expect(invoke).toHaveBeenCalledOnce();
  });
});

describe("copilot capability governance", () => {
  it("requires propose_context_variable to name a context-variables owner primitive", () => {
    const provenance = copilotCapabilityProvenance.propose_context_variable;
    const ownerPrimitiveIds = (provenance.applicationPrimitiveIds ?? []).filter((primitiveId) => {
      const metadata = copilotApplicationPrimitiveRegistry[primitiveId as keyof typeof copilotApplicationPrimitiveRegistry];
      return metadata?.owningModule === "contextVariables";
    });

    expect(ownerPrimitiveIds).not.toHaveLength(0);
    expect(provenance.rayOnly?.reason).not.toContain("no owner-module primitive");
  });

  it("rejects provenance entries for descriptors that are no longer assembled", () => {
    const assembled = {
      ...descriptor("workspace.agents.read"),
      name: "assembled_descriptor",
      capabilityProvenance: { rayOnly: { reason: "A focused test descriptor." } },
    };

    expect(() => assertCopilotCapabilityProvenanceRegistry([assembled], {
      assembled_descriptor: assembled.capabilityProvenance!,
      removed_descriptor: { rayOnly: { reason: "This descriptor was removed." } },
    })).toThrow("Stale copilot capability provenance");
    expect(() => assertCopilotCapabilityProvenanceRegistry([assembled], {}))
      .toThrow("Missing copilot capability provenance");
  });

  it("rejects a fabricated owner primitive and an empty Ray-only disposition", () => {
    const invalidPrimitive = {
      ...descriptor("workspace.agents.read"),
      capabilityProvenance: { applicationPrimitiveIds: ["invented.primitive"] },
    } satisfies CopilotToolDescriptor;
    const emptyDisposition = {
      ...descriptor("workspace.agents.read"),
      capabilityProvenance: { rayOnly: { reason: "  " } },
    };

    expect(() => assertCopilotCapabilityProvenance([invalidPrimitive], new Set())).toThrow("Unknown application primitive identity");
    expect(() => assertCopilotCapabilityProvenance([emptyDisposition], new Set())).toThrow("empty Ray-only reason");
  });

  it("requires a primitive identity to be exported by its owning module", () => {
    const ownerPrimitive = {
      ...descriptor("workspace.agents.read"),
      capabilityProvenance: { applicationPrimitiveIds: ["agents.configuration.read"] },
    } satisfies CopilotToolDescriptor;

    expect(() => assertCopilotCapabilityProvenance([ownerPrimitive], new Set())).toThrow("not exported by its owning module");
    expect(() => assertCopilotCapabilityProvenance(
      [ownerPrimitive], new Set(), {}, new Set(["agents.configuration.read"]),
    )).not.toThrow();
  });

  it("rejects a one-to-one descriptor whose permissions are weaker than its HTTP operation", () => {
    const weakened = {
      ...descriptor("workspace.agents.read"),
      capabilityProvenance: { backingOperationIds: ["validateAgentRoutine"] },
    } satisfies CopilotToolDescriptor;

    expect(() => assertCopilotCapabilityProvenance(
      [weakened],
      new Set(["validateAgentRoutine"]),
      { validateAgentRoutine: ["workspace.agents.manage"] },
    )).toThrow("weakens permission parity");
  });

  it("keeps one-to-one parity when a descriptor adds a primitive or Ray-only safety", () => {
    const composed = {
      ...descriptor("workspace.agents.read"),
      capabilityProvenance: {
        backingOperationIds: ["validateAgentRoutine"],
        applicationPrimitiveIds: ["routines.validation"],
        rayOnly: { reason: "Ray returns bounded diagnostics alongside validation." },
      },
    } satisfies CopilotToolDescriptor;

    expect(() => assertCopilotCapabilityProvenance(
      [composed],
      new Set(["validateAgentRoutine"]),
      { validateAgentRoutine: ["workspace.agents.manage"] },
      new Set(["routines.validation"]),
    )).toThrow("weakens permission parity");
  });
});
