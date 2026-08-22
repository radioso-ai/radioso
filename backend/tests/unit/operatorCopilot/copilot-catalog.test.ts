import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  filterCopilotToolCatalog,
  type CopilotToolDescriptor,
} from "../../../src/modules/operatorCopilot/public.js";

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
