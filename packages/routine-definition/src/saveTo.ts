import { z } from "zod";

/**
 * Where a slot keeps its value once the routine ends (#1884): `conversation` for this conversation,
 * `person` for the person the conversation is with, when it has a verified one.
 */
export const routineSlotSaveScopes = ["conversation", "person"] as const;

/**
 * A slot's save target: the attribute (context variable) its value is written to when the routine
 * reaches an ending, and the scope. Picked by the author; nothing infers it from the slot's key or
 * type. This package learns the shape only: the attribute's existence, type and trust are checked
 * where the agent's attributes are known.
 */
export const routineSlotSaveToSchemaFor = <TName extends z.ZodTypeAny>(contextVariable: TName) => z.object({
  contextVariable: contextVariable.describe("The name of the attribute the value is saved to. It must be enabled for the agent as a stored attribute, of a type that fits the field, and not signed."),
  scope: z.enum(routineSlotSaveScopes).describe("conversation keeps the value on this conversation; person keeps it on the conversation's verified person, and nothing is saved when there is none."),
}).strict().describe("The attribute this field's value is saved to when the routine ends complete or with a handoff. Set only to the attribute the operator names; never matched by the field's key or type.");

export type RoutineSlotSaveScope = typeof routineSlotSaveScopes[number];
