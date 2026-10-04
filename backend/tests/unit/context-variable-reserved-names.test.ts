import { describe, expect, it, vi } from "vitest";

import { ContextVariableService } from "../../src/modules/context-variables/services/contextVariableService.js";
import { isReservedContextVariableName } from "../../src/modules/context-variables/domain.js";

const service = (create = vi.fn(), update = vi.fn()) => new ContextVariableService({
  repository: { create, update },
  agentReader: {},
  agentSkillsReader: {},
} as never);

describe("reserved context variable names", () => {
  it("refuses to let a workspace variable occupy the namespace the prompts trust", async () => {
    // `radioso_caller_kind` is rendered into the same record as operator variables, and the
    // directive prompts are told it can be relied on. A workspace variable in that namespace would
    // carry a value the host page can supply at `trustTier: "unverified"` into the same trust.
    const create = vi.fn();
    await expect(service(create).create({ name: "radioso_verified_staff" } as never)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service(create).create({ name: "RADIOSO_Verified" } as never)).rejects.toMatchObject({ statusCode: 400 });
    expect(create).not.toHaveBeenCalled();
  });

  it("guards renames as well as creations, since the namespace is what matters, not the moment", async () => {
    const update = vi.fn();
    await expect(service(vi.fn(), update).update("ws-1", "var-1", { name: "radioso_caller_kind" }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it("leaves every ordinary name alone, including one that merely mentions the product", async () => {
    const create = vi.fn(async () => ({ id: "var-1" }));
    await expect(service(create).create({ name: "cart_value" } as never)).resolves.toBeDefined();
    await expect(service(create).create({ name: "radiosoplan" } as never)).resolves.toBeDefined();
    expect(isReservedContextVariableName("radioso_x")).toBe(true);
    expect(isReservedContextVariableName("radioso")).toBe(false);
  });
});
