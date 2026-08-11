import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  filterCopilotToolCatalog,
  type CopilotToolDescriptor,
} from "../../../src/modules/operatorCopilot/public.js";

const descriptor = (permission: CopilotToolDescriptor["requiredPermission"]): CopilotToolDescriptor => ({
  name: `tool_${permission.replaceAll(".", "_")}`,
  uiLabel: "Safe tool label",
  description: "A focused read-only operator capability.",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  requiredPermission: permission,
  contributingModule: "test",
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

    expect(catalog.map((tool) => tool.requiredPermission)).toEqual(["workspace.agents.read"]);
  });
});
