import { describe, expect, it } from "vitest";

import type { AgentToolDescriptor } from "../src/converseApiAdapter.js";
import { toRoutineToolInputSchema } from "../src/tools/routineToolSchema.js";

const inputSchema: AgentToolDescriptor["inputSchema"] = {
  type: "object",
  properties: {
    orderId: { type: "string", description: "The order number" },
    contact: { type: "string", format: "email" },
    pickupOn: { type: "string", format: "date" },
    quantity: { type: "number" },
    gift: { type: "boolean" },
  },
  required: ["orderId"],
  additionalProperties: false,
};

// The Standard Schema contract allows a sync or async `validate`; the tests accept either.
const validate = async (value: unknown) => await toRoutineToolInputSchema(inputSchema)["~standard"].validate(value);

describe("routine tool input schema", () => {
  it("advertises the descriptor's JSON Schema verbatim", () => {
    const schema = toRoutineToolInputSchema(inputSchema);

    expect(schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toEqual(inputSchema);
  });

  it("accepts input that matches the descriptor", async () => {
    await expect(validate({ orderId: "A-1001" })).resolves.toEqual({ value: { orderId: "A-1001" } });
    await expect(validate({
      orderId: "A-1001",
      contact: "sam@example.com",
      pickupOn: "2026-09-22",
      quantity: 2,
      gift: true,
    })).resolves.not.toHaveProperty("issues");
  });

  it("rejects a missing required slot, a wrong type, a bad format, and an unknown field", async () => {
    for (const input of [
      { contact: "sam@example.com" },
      { orderId: 1001 },
      { orderId: "A-1001", contact: "not-an-email" },
      { orderId: "A-1001", pickupOn: "next tuesday" },
      { orderId: "A-1001", extra: true },
    ]) {
      const result = await validate(input);
      expect(result.issues, JSON.stringify(input)).toBeDefined();
      expect(result.issues?.length).toBeGreaterThan(0);
    }
  });

  it("treats a slotless routine as an empty object", async () => {
    const empty = toRoutineToolInputSchema({ type: "object", properties: {}, required: [], additionalProperties: false });

    expect(await empty["~standard"].validate({})).toEqual({ value: {} });
    const rejected = await empty["~standard"].validate({ anything: 1 });
    expect(rejected.issues?.length).toBeGreaterThan(0);
  });
});
