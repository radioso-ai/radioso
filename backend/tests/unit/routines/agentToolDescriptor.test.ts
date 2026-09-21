import { describe, expect, it } from "vitest";

import { buildAgentToolDescriptor } from "../../../src/modules/routines/exposure/agentToolDescriptor.js";
import type { RoutineDefinition } from "../../../src/modules/routines/public.js";

type DescriptorSource = Parameters<typeof buildAgentToolDescriptor>[0];

const slot = (
  overrides: Partial<RoutineDefinition["slots"][number]> & Pick<RoutineDefinition["slots"][number], "key" | "type">,
): RoutineDefinition["slots"][number] => ({
  stableSlotId: `slot_${overrides.key}`,
  required: false,
  description: null,
  ordinal: 0,
  ...overrides,
});

const source = (overrides: Partial<DescriptorSource> = {}): DescriptorSource => ({
  lineageId: "lineage-return",
  slots: [],
  exposure: { enabled: true, toolName: "start_return", description: "Start a return for an order." },
  ...overrides,
});

describe("buildAgentToolDescriptor", () => {
  it("maps every declared slot type onto its JSON Schema shape and keeps required from the slot", () => {
    const descriptor = buildAgentToolDescriptor(source({
      slots: [
        slot({ key: "orderId", type: "text", required: true, description: "The order number", ordinal: 0 }),
        slot({ key: "quantity", type: "number", ordinal: 1 }),
        slot({ key: "gift", type: "boolean", ordinal: 2 }),
        slot({ key: "contact", type: "email", required: true, ordinal: 3 }),
        slot({ key: "purchasedOn", type: "date", ordinal: 4 }),
      ],
    }));

    expect(descriptor).toEqual({
      toolName: "start_return",
      description: "Start a return for an order.",
      routineLineageId: "lineage-return",
      inputSchema: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "The order number" },
          quantity: { type: "number" },
          gift: { type: "boolean" },
          contact: { type: "string", format: "email" },
          purchasedOn: { type: "string", format: "date" },
        },
        required: ["orderId", "contact"],
        additionalProperties: false,
      },
    });
  });

  it("orders properties by slot ordinal, not authoring order", () => {
    const descriptor = buildAgentToolDescriptor(source({
      slots: [
        slot({ key: "second", type: "text", ordinal: 1 }),
        slot({ key: "first", type: "text", ordinal: 0 }),
      ],
    }));

    expect(Object.keys(descriptor.inputSchema.properties)).toEqual(["first", "second"]);
  });

  it("describes a routine with no slots as an empty object schema", () => {
    const descriptor = buildAgentToolDescriptor(source({ slots: [] }));

    expect(descriptor.inputSchema).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
});
