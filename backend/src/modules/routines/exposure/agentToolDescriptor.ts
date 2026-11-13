import type { RoutineDefinition, RoutineSlotType } from "../domain.js";

export type AgentToolInputPropertyType = "string" | "number" | "boolean";
export type AgentToolInputPropertyFormat = "email" | "date";

export interface AgentToolInputProperty {
  type: AgentToolInputPropertyType;
  format?: AgentToolInputPropertyFormat;
  description?: string;
}

/** The JSON Schema object a calling agent validates its tool input against. */
export interface AgentToolInputSchema {
  type: "object";
  properties: Record<string, AgentToolInputProperty>;
  required: string[];
  additionalProperties: false;
}

/**
 * How a calling agent sees one exposed routine: the name it invokes, the
 * operator-authored description, a JSON Schema derived from the routine's
 * declared slots, and the lineage the tool belongs to. This is the shared port
 * between the routines module and every transport (catalog route, MCP tool
 * list, cards); it is published once in OpenAPI as `AgentToolDescriptor`.
 */
export interface AgentToolDescriptor {
  toolName: string;
  description: string;
  inputSchema: AgentToolInputSchema;
  routineLineageId: string;
}

const propertyFor = (slotType: Exclude<RoutineSlotType, "item">): Pick<AgentToolInputProperty, "type" | "format"> => {
  switch (slotType) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "email":
      return { type: "string", format: "email" };
    case "date":
      return { type: "string", format: "date" };
    case "text":
      return { type: "string" };
  }
};

type DescriptorSource = Pick<RoutineDefinition, "lineageId" | "slots" | "consents"> & {
  exposure: NonNullable<RoutineDefinition["exposure"]>;
};

/**
 * Derives the descriptor from the declared slots alone: they are the routine's
 * complete input contract (a step that references an undeclared slot already
 * fails validation), so no inference is needed. A routine with no slots is a
 * tool with an empty object schema.
 *
 * A slot a consent covers is left out (#1544): only the visitor can consent to it, a
 * calling agent's channel never asks, and the engine refuses its value from a call, so
 * offering it would only invite input that is dropped. An `item` slot is left out too: only the
 * visitor's pick of a card the routine showed fills it (#1763).
 */
export const buildAgentToolDescriptor = (definition: DescriptorSource): AgentToolDescriptor => {
  const covered = new Set((definition.consents ?? []).flatMap((consent) => consent.slotKeys));
  const slots = [...definition.slots]
    .filter((slot): slot is typeof slot & { type: Exclude<RoutineSlotType, "item"> } => !covered.has(slot.key) && slot.type !== "item")
    .sort((left, right) => left.ordinal - right.ordinal);
  const properties: Record<string, AgentToolInputProperty> = {};
  for (const slot of slots) {
    properties[slot.key] = {
      ...propertyFor(slot.type),
      ...(slot.description ? { description: slot.description } : {}),
    };
  }
  return {
    toolName: definition.exposure.toolName,
    description: definition.exposure.description,
    inputSchema: {
      type: "object",
      properties,
      required: slots.filter((slot) => slot.required).map((slot) => slot.key),
      additionalProperties: false,
    },
    routineLineageId: definition.lineageId,
  };
};
