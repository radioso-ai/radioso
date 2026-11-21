import { describe, expect, it } from "vitest";

import {
  freezeTestValues,
  type ContextVariableTestValueCatalogPort,
} from "../../src/modules/context-variables/public.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const stringId = "00000000-0000-4000-8000-000000000002";
const jsonId = "00000000-0000-4000-8000-000000000003";
const enumId = "00000000-0000-4000-8000-000000000004";

const catalog: ContextVariableTestValueCatalogPort = {
  async get(_workspaceId, id) {
    if (id === stringId) return {
      id, workspaceId, name: "customer", description: null, valueType: "string", options: null,
      trustTier: "signed", sensitivity: "normal", defaultSurfacing: "always",
      createdAt: new Date(0), updatedAt: new Date(0),
    };
    if (id === jsonId) return {
      id, workspaceId, name: "cart", description: null, valueType: "json", options: null,
      trustTier: "unverified", sensitivity: "sensitive", defaultSurfacing: "always",
      createdAt: new Date(0), updatedAt: new Date(0),
    };
    if (id === enumId) return {
      id, workspaceId, name: "topic", description: null, valueType: "enum",
      options: [
        { key: "billing", label: "Billing", description: null, archived: false },
        { key: "legacy", label: "Legacy", description: null, archived: true },
      ],
      trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
      createdAt: new Date(0), updatedAt: new Date(0),
    };
    return null;
  },
};

describe("freezeTestValues", () => {
  it("requires every enabled frozen definition even when no sample is supplied", async () => {
    await expect(freezeTestValues({
      workspaceId,
      catalog: { async get() { return null; } },
      selectedEnablements: [[{ variableId: stringId, enabled: true }]],
      supplied: [],
    })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("requires values to be enabled by every selected revision and freezes catalog metadata", async () => {
    const frozen = await freezeTestValues({
      workspaceId,
      catalog,
      selectedEnablements: [
        [{ variableId: stringId, enabled: true }, { variableId: jsonId, enabled: true }],
        [{ variableId: stringId, enabled: true }, { variableId: jsonId, enabled: false }],
      ],
      supplied: [{ contextVariableId: stringId, value: "Ada" }],
    });

    expect(frozen).toEqual([{
      contextVariableId: stringId, value: "Ada", name: "customer", description: null,
      sensitive: false, trust: "verified",
    }]);
    await expect(freezeTestValues({
      workspaceId, catalog,
      selectedEnablements: [[{ variableId: jsonId, enabled: true }]],
      supplied: [{ contextVariableId: jsonId, value: undefined }],
    })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("takes an enum sample only as the key of an active option", async () => {
    const select = [[{ variableId: enumId, enabled: true }]];
    await expect(freezeTestValues({ workspaceId, catalog, selectedEnablements: select, supplied: [{ contextVariableId: enumId, value: "billing" }] }))
      .resolves.toMatchObject([{ contextVariableId: enumId, value: "billing", label: "Billing" }]);
    for (const value of ["legacy", "Billing", 1]) {
      await expect(freezeTestValues({ workspaceId, catalog, selectedEnablements: select, supplied: [{ contextVariableId: enumId, value }] }))
        .rejects.toMatchObject({ code: "bad_request" });
    }
  });
});
